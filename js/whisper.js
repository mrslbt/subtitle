/**
 * WhisperClient — push-to-talk recording with LIVE partial transcription.
 *
 * Flow:
 *   start()  → mic opens, recording begins, placeholder entry via onStart
 *              every 1500ms a chunk fires → cumulative audio sent to /transcribe
 *              JP text updates via onPartial as the user speaks
 *   stop()   → final transcribe on full blob → onPartial with final JP
 *              → /translate_stream → onPartial accumulates EN tokens
 *              → onResult when translation complete
 *
 * Callbacks:
 *   onStart()                          — placeholder entry should appear
 *   onPartial({ japanese, english })   — live update (either side can be empty)
 *   onResult({ japanese, english })    — final result, triggers TTS
 *   onStateChange('listening'|'translating'|'stopped')
 *   onVolume(0-1)
 *   onDuration(elapsedMs, maxMs)
 *   onDebug(msg)
 *   onError(err)
 */

export class WhisperClient {
  constructor(serverUrl, opts = {}) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.deviceId = opts.deviceId || '';

    this.stream = null;
    this.mediaRecorder = null;
    this.audioContext = null;
    this.analyser = null;

    this._rafId = null;
    this._chunks = [];
    this._isRecording = false;
    this._mime = '';
    this._startTime = 0;
    this._debug = true;

    // Partial streaming state
    this._partialSeq = 0;
    this._renderedSeq = 0;
    this._partialInFlight = false;

    // Limits
    this.MAX_DURATION_MS = 60000;      // 60s hard cap
    this.PARTIAL_INTERVAL_MS = 1500;   // JP partial cadence

    // Preferences (set by app)
    this.modelPref = 'accuracy'; // 'accuracy' | 'speed'

    // Callbacks
    this.onStart = null;
    this.onResult = null;
    this.onPartial = null;
    this.onStateChange = null;
    this.onError = null;
    this.onVolume = null;
    this.onDuration = null;
    this.onDebug = null;
    this.getContext = null;
  }

  get supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }

  _log(msg) { if (this._debug) console.log('[whisper]', msg); this.onDebug?.(msg); }

  _pickMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/wav',
    ];
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  async start() {
    if (!this.supported) {
      this.onError?.({ error: 'not-supported', message: 'Your browser lacks MediaRecorder or getUserMedia.' });
      return;
    }
    if (this._isRecording) return;

    try {
      // CONVO = close-talk (phone/laptop near one speaker). Keep browser DSP on.
      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (this.deviceId) audioConstraints.deviceId = { exact: this.deviceId };
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      const track = this.stream.getAudioTracks()[0];
      this._log(`mic acquired: ${track?.label || '(unknown)'}`);
    } catch (err) {
      this.onError?.({
        error: 'not-allowed',
        message: err.name === 'NotAllowedError'
          ? 'Mic access denied. Allow it in browser settings.'
          : `Can't access microphone: ${err.message}`,
      });
      return;
    }

    this._mime = this._pickMime();
    this._log(`mime: ${this._mime || '(default)'}`);

    try { await this._setupAnalyser(); }
    catch (e) { this._log(`analyser failed: ${e.message}`); }

    this._chunks = [];
    this._partialSeq = 0;
    this._renderedSeq = 0;
    this._partialInFlight = false;

    try {
      this.mediaRecorder = this._mime
        ? new MediaRecorder(this.stream, { mimeType: this._mime })
        : new MediaRecorder(this.stream);
    } catch (e) {
      this._log(`recorder fallback: ${e.message}`);
      this.mediaRecorder = new MediaRecorder(this.stream);
    }

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this._chunks.push(e.data);
        this._maybeSendPartial();
      }
    };

    this.mediaRecorder.onstop = async () => {
      const type = this.mediaRecorder.mimeType || this._mime || 'audio/webm';
      const blob = new Blob(this._chunks, { type });
      this._chunks = [];
      this._renderedSeq = Number.POSITIVE_INFINITY; // drop any late partials
      this._cleanup();

      if (blob.size < 500) {
        this._log('final blob too small — skipping');
        this.onStateChange?.('stopped');
        return;
      }

      await this._finalize(blob, type);
      this.onStateChange?.('stopped');
    };

    this.mediaRecorder.onerror = (e) => {
      this._log(`recorder error: ${e.error?.message || 'unknown'}`);
    };

    try {
      // Timeslice: chunk auto-fires every PARTIAL_INTERVAL_MS
      this.mediaRecorder.start(this.PARTIAL_INTERVAL_MS);
      this._isRecording = true;
      this._startTime = performance.now();
      this._log(`recording · tap to stop · partials every ${this.PARTIAL_INTERVAL_MS}ms`);
      this.onStateChange?.('listening');
      this.onStart?.();
      this._startVolumeLoop();
    } catch (e) {
      this._log(`start failed: ${e.message}`);
    }
  }

  async _setupAnalyser() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AC();
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.5;
    source.connect(this.analyser);
  }

  _startVolumeLoop() {
    if (!this.analyser) return;
    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    const loop = () => {
      if (!this._isRecording) return;
      this.analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      const avg = sum / buf.length;
      this.onVolume?.(Math.min(1, avg / 50));

      const elapsed = performance.now() - this._startTime;
      this.onDuration?.(elapsed, this.MAX_DURATION_MS);

      if (elapsed >= this.MAX_DURATION_MS) {
        this._log(`max duration reached — auto-stop`);
        this._rafId = null;
        this.stop();
        return;
      }

      this._rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  _maybeSendPartial() {
    if (!this._isRecording) return;
    if (this._partialInFlight) return;
    if (this._chunks.length === 0) return;

    const seq = ++this._partialSeq;
    this._partialInFlight = true;

    const blob = new Blob(this._chunks, { type: this._mime || 'audio/webm' });
    this._log(`partial seq=${seq} size=${blob.size}B chunks=${this._chunks.length}`);
    this._sendPartial(blob, seq);
  }

  async _sendPartial(blob, seq) {
    const ext = (this._mime || '').includes('mp4') ? 'mp4' : 'webm';
    try {
      const form = new FormData();
      form.append('audio', blob, `partial.${ext}`);
      const t0 = performance.now();
      // Partials always use the fast Japanese-specialized model (kotoba).
      // Results get overwritten by the final pass, so there's no reason to
      // burn Mac mini compute on large-v3 for throwaway mid-utterance passes.
      const res = await fetch(this.serverUrl + `/transcribe?model=speed`, { method: 'POST', body: form });
      const dt = Math.round(performance.now() - t0);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const jp = (data.japanese || '').trim();

      if (seq <= this._renderedSeq) return; // a newer partial already rendered
      this._renderedSeq = seq;
      if (jp) {
        this._log(`partial ${dt}ms: "${jp.slice(0, 50)}"`);
        this.onPartial?.({ japanese: jp, english: '' });
      }
    } catch (err) {
      this._log(`partial failed: ${err.message}`);
    } finally {
      this._partialInFlight = false;
    }
  }

  // Final pass after user stops: authoritative transcription + streaming translation
  async _finalize(blob, type) {
    this.onStateChange?.('translating');
    const ext = type.includes('webm') ? 'webm'
              : type.includes('mp4') ? 'mp4'
              : type.includes('ogg') ? 'ogg'
              : 'audio';

    // Final transcribe (most accurate — Whisper has full audio context now)
    let japanese = '';
    try {
      const form = new FormData();
      form.append('audio', blob, `final.${ext}`);
      const t0 = performance.now();
      const res = await fetch(this.serverUrl + `/transcribe?final=true&model=${this.modelPref}`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      japanese = (data.japanese || '').trim();
      this._log(`final jp ${Math.round(performance.now() - t0)}ms: "${japanese.slice(0, 50)}"`);
    } catch (err) {
      this._log(`final transcribe failed: ${err.message}`);
      this.onError?.({ error: 'server', message: `Transcribe: ${err.message}` });
      return;
    }

    if (!japanese) {
      this._log('empty final transcription');
      return;
    }

    // Emit final JP immediately so UI locks it in
    this.onPartial?.({ japanese, english: '' });

    // Stream translation
    const context = this.getContext?.() || [];
    if (context.length > 0) this._log(`context: ${context.length} exchanges`);

    try {
      const streamRes = await fetch(this.serverUrl + '/translate_stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: japanese, context: context.slice(-5) }),
      });
      if (!streamRes.ok || !streamRes.body) throw new Error(`translate stream HTTP ${streamRes.status}`);

      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let english = '';
      let firstTokenAt = 0;
      const t0 = performance.now();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          let payload;
          try { payload = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (payload.delta) {
            if (!firstTokenAt) firstTokenAt = performance.now();
            english += payload.delta;
            this.onPartial?.({ japanese, english: english.trim() });
          }
          if (payload.done) {
            const total = Math.round(performance.now() - t0);
            const first = firstTokenAt ? Math.round(firstTokenAt - t0) : total;
            this._log(`en first=${first}ms total=${total}ms`);
            this.onResult?.({ japanese, english: english.trim(), backend: 'stream', done: true });
            return;
          }
        }
      }
      this.onResult?.({ japanese, english: english.trim(), backend: 'stream', done: true });
    } catch (err) {
      this._log(`translate failed: ${err.message}`);
      this.onError?.({ error: 'server', message: `Translate: ${err.message}` });
    }
  }

  stop() {
    if (!this._isRecording) { this._cleanup(); this.onStateChange?.('stopped'); return; }
    this._isRecording = false;
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.onStateChange?.('translating');
      try { this.mediaRecorder.stop(); } catch (e) {}
    } else {
      this._cleanup();
      this.onStateChange?.('stopped');
    }
  }

  _cleanup() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      try { this.audioContext.close(); } catch (e) {}
      this.audioContext = null;
    }
    this.onVolume?.(0);
  }

  async healthCheck() {
    try {
      const res = await fetch(this.serverUrl + '/health', { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { ok: false };
      return { ok: true, ...(await res.json()) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}
