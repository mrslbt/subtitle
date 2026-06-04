/**
 * RealtimeClient — meeting mode powered by OpenAI gpt-realtime-translate.
 *
 * Architecture (vs the older MeetingClient):
 *   - Audio capture: AudioWorklet at 24 kHz PCM16, streamed continuously
 *     over a WebSocket to the server's /realtime proxy, which forwards
 *     to OpenAI. EN transcript deltas stream back the same way.
 *   - JP transcript: MediaRecorder + VAD chunking still runs in parallel
 *     and hits /transcribe (Whisper) per utterance for the JP side.
 *     gpt-realtime-translate is EN-only output.
 *   - Attribution: VAD utterance boundaries tag a "current target" id.
 *     EN deltas arriving while that tag is live go to that utterance.
 *     After silence cut we keep collecting for TAIL_WINDOW_MS so the
 *     late verb in Japanese SOV sentences still lands on the right row.
 *
 * Why this beats the Ollama pipeline:
 *   - No serial Whisper-then-translate chain — EN pace-matches the
 *     speaker, so the user sees translation forming WHILE they're
 *     still talking instead of 3-5s after they stop.
 *   - The model handles JP verb-late natively; no more half-translations
 *     that change meaning when the verb finally arrives.
 *   - qwen2.5:1.5b's preamble hallucinations ("Sure! Here's your
 *     translation…") are gone — gpt-realtime-translate is a translation
 *     model, not a chat model, so it just translates.
 *
 * Callbacks: same shape as MeetingClient so app.js wires up identically.
 *   onSpeechStart({id}), onPartial({id, japanese}),
 *   onTranscription({id, japanese}), onTranslation({id, english, done}),
 *   onStateChange(state), onVolume(0-1), onError(err), onDebug(msg)
 */

export class RealtimeClient {
  constructor(serverUrl, opts = {}) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.deviceId = opts.deviceId || '';

    // Audio capture
    this.stream = null;
    this.audioContext = null;
    this.analyser = null;
    this.workletNode = null;
    this.mediaRecorder = null;

    // WebSocket to /realtime
    this.ws = null;
    this._wsReady = false;
    this._reconnectAttempts = 0;

    // State
    this._isActive = false;
    this._rafId = null;
    this._chunks = [];
    this._hadSpeech = false;
    this._speechStartEmitted = false;
    this._speechStart = 0;
    this._lastSpeechTime = 0;
    this._nextId = 1;
    this._currentEntryId = null;
    this._partialSeq = 0;
    this._renderedSeq = 0;
    this._partialInFlight = false;
    this._partialStartedAt = 0;
    this._mime = '';

    // EN attribution
    // _enTargetId — utterance currently collecting EN deltas (or null).
    // _enBuffer  — Map<id, string> of accumulated EN text per utterance.
    // _tailTimer — fires TAIL_WINDOW_MS after silence cut to lock EN.
    this._enTargetId = null;
    this._enBuffer = new Map();
    this._tailTimer = null;

    // Tunables — match MeetingClient for VAD behavior, plus realtime-specific.
    this.VOICE_THRESHOLD = 10;
    this.SILENCE_MS = 1800;
    this.MIN_SPEECH_MS = 500;
    this.MAX_CHUNK_MS = 20000;
    this.PARTIAL_INTERVAL_MS = 1500;
    // How long after silence we keep attributing deltas to the cut utterance.
    // SOV verb-late tail: OpenAI's pace-matched model often emits the
    // English verb 0.5-1.5s after the speaker stops. Anything longer is
    // unlikely to belong to that utterance.
    this.TAIL_WINDOW_MS = 1500;

    // Callbacks
    this.onSpeechStart = null;
    this.onPartial = null;
    this.onTranscription = null;
    this.onTranslation = null;
    this.onStateChange = null;
    this.onVolume = null;
    this.onError = null;
    this.onDebug = null;
    this.getContext = null;
  }

  get supported() {
    return !!(
      navigator.mediaDevices?.getUserMedia &&
      window.MediaRecorder &&
      window.AudioContext &&
      window.AudioWorkletNode
    );
  }

  _log(msg) { console.log('[realtime]', msg); this.onDebug?.(msg); }

  // Same fetch-with-abort helper as MeetingClient. See its comment block
  // for why we don't clearTimeout the timer on fetch-resolve.
  _fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...opts, signal: controller.signal });
  }

  _pickMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  async start() {
    if (!this.supported) {
      this.onError?.({
        error: 'not-supported',
        message: 'AudioWorklet or MediaRecorder not supported in this browser.',
      });
      return;
    }
    if (this._isActive) return;

    try {
      const audioConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
      if (this.deviceId) audioConstraints.deviceId = { exact: this.deviceId };
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      const track = this.stream.getAudioTracks()[0];
      this._log(`mic: ${track?.label || '(unknown)'}`);
    } catch (err) {
      this.onError?.({
        error: 'not-allowed',
        message: err.name === 'NotAllowedError'
          ? 'Mic access denied.'
          : `Can't access microphone: ${err.message}`,
      });
      return;
    }

    this._mime = this._pickMime();
    this._log(`mime: ${this._mime || '(default)'}`);

    // Order matters: open the WebSocket before audio worklet starts pumping
    // so we don't drop frames before the upstream is ready.
    await this._openWebSocket();
    await this._setupAudio();

    this._isActive = true;
    this._startChunk();
    this._startVADLoop();
    this.onStateChange?.('listening');
    this._log('realtime started · openai pace-matched + whisper JP');
  }

  async _openWebSocket() {
    return new Promise((resolve) => {
      // Convert https://host → wss://host, http://host → ws://host
      const wsUrl = this.serverUrl.replace(/^http/, 'ws') + '/realtime';
      this._log(`opening ${wsUrl}`);
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this._log('websocket open');
        // Don't resolve yet — wait for {type:"ready"} from server which
        // means OpenAI upstream is connected and session.update sent.
      };

      this.ws.onmessage = (ev) => this._onWsMessage(ev);

      this.ws.onerror = (err) => {
        this._log(`websocket error: ${err.message || 'unknown'}`);
      };

      this.ws.onclose = (ev) => {
        this._wsReady = false;
        this._log(`websocket closed (code=${ev.code})`);
        // Try to reconnect mid-session if we're still supposed to be active.
        if (this._isActive && this._reconnectAttempts < 3) {
          this._reconnectAttempts++;
          const delay = 500 * this._reconnectAttempts;
          this._log(`reconnect attempt ${this._reconnectAttempts} in ${delay}ms`);
          setTimeout(() => this._openWebSocket(), delay);
        } else if (this._isActive) {
          this.onError?.({
            error: 'server',
            message: 'Lost connection to translation server.',
          });
        }
      };

      // Wait for ready, with a connect timeout.
      const timeout = setTimeout(() => {
        if (!this._wsReady) {
          this._log('websocket ready-timeout (10s)');
          resolve();  // fall through; the WS handlers will surface errors
        }
      }, 10000);

      this._wsReadyResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  }

  _onWsMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const t = msg.type;

    if (t === 'ready') {
      this._wsReady = true;
      this._reconnectAttempts = 0;
      this._wsReadyResolve?.();
      this._wsReadyResolve = null;
      this._log('upstream ready');
      return;
    }

    if (t === 'delta') {
      const text = msg.text || '';
      if (!text) return;
      this._handleEnDelta(text);
      return;
    }

    if (t === 'done') {
      // OpenAI flushed its translation turn — if we have a target with
      // accumulated EN, lock it now rather than waiting for the tail timer.
      this._lockCurrentEn();
      return;
    }

    if (t === 'error') {
      this._log(`upstream error: ${msg.message || ''}`);
      // Non-fatal errors we just log; fatal ones the WS close handler
      // will catch.
      return;
    }
  }

  // Append a delta to the currently-attributed utterance's EN buffer.
  _handleEnDelta(text) {
    const target = this._enTargetId;
    if (!target) {
      // No utterance is currently collecting — this can happen if EN
      // tail arrives after we already locked. Drop on the floor; better
      // than misattributing to the next utterance.
      return;
    }
    const cur = (this._enBuffer.get(target) || '') + text;
    this._enBuffer.set(target, cur);
    this.onTranslation?.({ id: target, english: cur, done: false });
  }

  // Finalize the EN for the currently-targeted utterance.
  _lockCurrentEn() {
    if (this._tailTimer) {
      clearTimeout(this._tailTimer);
      this._tailTimer = null;
    }
    const id = this._enTargetId;
    if (!id) return;
    const en = (this._enBuffer.get(id) || '').trim();
    this._enTargetId = null;
    if (en) {
      this.onTranslation?.({ id, english: en, done: true });
    } else {
      // No EN came back for this utterance (silence, hallucination filter,
      // or upstream lag). Emit a done with empty so the UI stops spinning.
      this.onTranslation?.({ id, english: '', done: true });
    }
  }

  async _setupAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AC();
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();

    const source = this.audioContext.createMediaStreamSource(this.stream);

    // Analyser branch — for VAD (volume + speech detection)
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.5;
    source.connect(this.analyser);

    // AudioWorklet branch — for continuous PCM16 capture → WebSocket
    try {
      // Cache-busting: import.meta.url has a ?v=<hash> param injected by
      // the server. new URL('./x', base) keeps the path but drops the
      // base's query string, so we re-attach v manually — otherwise
      // the worklet gets stuck at whatever version the browser cached
      // the first time it loaded.
      const moduleUrl = new URL(import.meta.url);
      const v = moduleUrl.searchParams.get('v');
      const workletUrl = new URL(
        './pcm-worklet.js' + (v ? `?v=${v}` : ''),
        moduleUrl,
      ).toString();
      await this.audioContext.audioWorklet.addModule(workletUrl);
    } catch (e) {
      this._log(`worklet load failed: ${e.message}`);
      throw e;
    }
    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');
    this.workletNode.port.onmessage = (ev) => {
      if (!this._wsReady || this.ws?.readyState !== WebSocket.OPEN) return;
      const buf = ev.data.pcm16;
      if (!buf) return;
      // Base64-encode the Int16 PCM frame for transport.
      const b64 = this._arrayBufferToBase64(buf);
      try {
        this.ws.send(JSON.stringify({ type: 'audio', data: b64 }));
      } catch (e) {
        this._log(`ws send failed: ${e.message}`);
      }
    };
    source.connect(this.workletNode);
    // Don't connect worklet to destination — we don't want to echo mic
    // to speakers. The .process() callback fires regardless.
  }

  // ArrayBuffer → base64. Standard btoa() trick: build a binary string
  // chunk-by-chunk to avoid the call-stack limit on huge args.
  _arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  _startVADLoop() {
    if (!this.analyser) return;
    const buf = new Uint8Array(this.analyser.frequencyBinCount);

    const loop = () => {
      if (!this._isActive) return;

      this.analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      const avg = sum / buf.length;
      this.onVolume?.(Math.min(1, avg / 50));

      const now = performance.now();

      if (avg > this.VOICE_THRESHOLD) {
        if (!this._speechStart) this._speechStart = now;
        this._lastSpeechTime = now;
        this._hadSpeech = true;

        if (!this._speechStartEmitted && now - this._speechStart > 150) {
          this._speechStartEmitted = true;
          this._currentEntryId = this._nextId++;
          this._renderedSeq = 0;
          this._partialSeq = 0;
          this._log(`[#${this._currentEntryId}] speech start`);
          this.onSpeechStart?.({ id: this._currentEntryId });

          // Re-target EN deltas to the new utterance. If a tail window
          // from the previous one is still active, lock it now — a new
          // utterance starting clearly means the previous one is done.
          if (this._enTargetId && this._enTargetId !== this._currentEntryId) {
            this._lockCurrentEn();
          }
          this._enTargetId = this._currentEntryId;
        }
      }

      if (
        this._hadSpeech &&
        this._lastSpeechTime &&
        now - this._lastSpeechTime > this.SILENCE_MS &&
        now - this._speechStart > this.MIN_SPEECH_MS
      ) {
        this._cutChunk('silence');
      }

      if (this._speechStart && now - this._speechStart > this.MAX_CHUNK_MS) {
        this._cutChunk('max duration');
      }

      // Watchdog (same as MeetingClient — keeps the JP-partials pipeline
      // unblocked if a fetch hangs past its timeout).
      if (this._partialInFlight && this._partialStartedAt &&
          now - this._partialStartedAt > 12000) {
        this._log('[watchdog] partial stuck >12s, force-resetting');
        this._partialInFlight = false;
        this._partialStartedAt = 0;
      }

      // Resume context if backgrounded.
      if (this.audioContext && this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(() => {});
      }

      this._rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  _maybeSendPartial() {
    if (!this._isActive) return;
    if (!this._speechStartEmitted) return;
    if (!this._currentEntryId) return;
    if (this._partialInFlight) return;
    if (this._chunks.length === 0) return;

    const entryId = this._currentEntryId;
    const seq = ++this._partialSeq;
    this._partialInFlight = true;
    this._partialStartedAt = performance.now();

    const blob = new Blob(this._chunks, { type: this._mime || 'audio/webm' });
    this._log(`[#${entryId}] partial send seq=${seq} size=${blob.size}B`);
    this._sendPartial(entryId, blob, seq);
  }

  async _sendPartial(entryId, blob, seq) {
    const ext = (this._mime || '').includes('mp4') ? 'mp4' : 'webm';
    try {
      const form = new FormData();
      form.append('audio', blob, `partial.${ext}`);
      const t0 = performance.now();
      const res = await this._fetchWithTimeout(
        this.serverUrl + `/transcribe?model=speed`,
        { method: 'POST', body: form },
        8000,
      );
      const dt = Math.round(performance.now() - t0);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const jp = (data.japanese || '').trim();

      if (seq <= this._renderedSeq) return;
      if (entryId !== this._currentEntryId) return;

      this._renderedSeq = seq;
      if (jp) {
        this._log(`[#${entryId} jp-partial ${dt}ms] ${jp.slice(0, 60)}`);
        this.onPartial?.({ id: entryId, japanese: jp });
      }
    } catch (err) {
      this._log(`[#${entryId} jp-partial failed] ${err.message}`);
    } finally {
      this._partialInFlight = false;
      this._partialStartedAt = 0;
    }
  }

  _startChunk() {
    this._chunks = [];
    this._hadSpeech = false;
    this._speechStartEmitted = false;
    this._speechStart = 0;
    this._lastSpeechTime = 0;

    try {
      this.mediaRecorder = this._mime
        ? new MediaRecorder(this.stream, { mimeType: this._mime })
        : new MediaRecorder(this.stream);
    } catch (e) {
      this.mediaRecorder = new MediaRecorder(this.stream);
    }

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this._chunks.push(e.data);
        this._maybeSendPartial();
      }
    };

    this.mediaRecorder.onstop = () => {
      const type = this.mediaRecorder.mimeType || this._mime || 'audio/webm';
      const blob = new Blob(this._chunks, { type });
      const hadSpeech = this._hadSpeech;
      const finalizedEntryId = this._currentEntryId;

      this._chunks = [];
      this._currentEntryId = null;
      this._renderedSeq = Number.POSITIVE_INFINITY;

      if (hadSpeech && blob.size > 1000 && finalizedEntryId) {
        // JP final pass via Whisper (unchanged from MeetingClient logic).
        this._processFinalJP(finalizedEntryId, blob, type);

        // Arm the tail timer: after TAIL_WINDOW_MS, lock whatever EN
        // we've accumulated for this utterance. Late deltas after this
        // get dropped (or, in practice, the next speech-start has
        // already retargeted by then).
        this._armTailTimer(finalizedEntryId);
      }

      if (this._isActive) this._startChunk();
    };

    try {
      this.mediaRecorder.start(this.PARTIAL_INTERVAL_MS);
      this._log(`recorder started, timeslice=${this.PARTIAL_INTERVAL_MS}ms`);
    } catch (e) {
      this._log(`start failed: ${e.message}`);
    }
  }

  _armTailTimer(id) {
    if (this._tailTimer) clearTimeout(this._tailTimer);
    this._tailTimer = setTimeout(() => {
      this._tailTimer = null;
      // Only lock if we're still on this id (a new utterance hasn't
      // already started and stolen the target).
      if (this._enTargetId === id) {
        this._lockCurrentEn();
      }
    }, this.TAIL_WINDOW_MS);
  }

  _cutChunk(reason) {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this._log(`cut (${reason})`);
      try { this.mediaRecorder.stop(); } catch (e) {}
    }
  }

  async _processFinalJP(id, blob, type) {
    const ext = type.includes('webm') ? 'webm' : type.includes('mp4') ? 'mp4' : 'audio';
    try {
      const form = new FormData();
      form.append('audio', blob, `final.${ext}`);
      const t0 = performance.now();
      const res = await this._fetchWithTimeout(
        this.serverUrl + `/transcribe?final=true&model=speed`,
        { method: 'POST', body: form },
        15000,
      );
      const dt = Math.round(performance.now() - t0);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const japanese = (data.japanese || '').trim();

      if (data.dropped === 'hallucination') {
        // Whisper post-filter flagged this as a repetition loop. The audio
        // was probably noise/silence — the realtime EN is almost certainly
        // wrong too. Clear both.
        this._log(`[#${id} jp-final ${dt}ms] DROPPED as hallucination`);
        this.onTranscription?.({ id, japanese: '' });
        // Wipe accumulated EN for this utterance and lock empty.
        this._enBuffer.set(id, '');
        if (this._enTargetId === id) {
          this.onTranslation?.({ id, english: '', done: true });
          this._enTargetId = null;
          if (this._tailTimer) { clearTimeout(this._tailTimer); this._tailTimer = null; }
        } else {
          this.onTranslation?.({ id, english: '', done: true });
        }
        return;
      }

      this._log(`[#${id} jp-final ${dt}ms] ${japanese.slice(0, 80)}`);
      // Always emit whatever Whisper produced (could be '' for silence).
      // We deliberately DO NOT touch the EN side here — the realtime
      // stream owns EN. Whisper's silence ≠ OpenAI's silence; sometimes
      // OpenAI translates audio Whisper labels as empty.
      this.onTranscription?.({ id, japanese });
    } catch (err) {
      this._log(`[#${id} jp-final failed] ${err.message}`);
    }
  }

  stop() {
    this._isActive = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._tailTimer) {
      clearTimeout(this._tailTimer);
      this._tailTimer = null;
    }
    // Lock any in-flight EN so the last utterance isn't left dangling.
    if (this._enTargetId) this._lockCurrentEn();

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch (e) {}
    }
    if (this.workletNode) {
      try { this.workletNode.disconnect(); } catch (e) {}
      this.workletNode = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      try { this.audioContext.close(); } catch (e) {}
      this.audioContext = null;
    }
    this._wsReady = false;
    this._enBuffer.clear();
    this._enTargetId = null;
    this.onVolume?.(0);
    this.onStateChange?.('stopped');
    this._log('realtime stopped');
  }
}
