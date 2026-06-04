/**
 * MeetingClient — continuous recording with VAD-based chunking +
 * live partial transcription with speculative translation.
 *
 * Pipeline (optimized for live-meeting latency):
 *   speech detected → onSpeechStart (empty entry appears)
 *   every 1.5s while speaking → send cumulative audio → onPartial (JP grows)
 *   silence detected → in parallel:
 *     (a) Whisper final pass on full audio (speed model only — large-v3's
 *         1-2s cost isn't worth the small accuracy bump for live reading)
 *     (b) speculative translate_stream on the most-recent partial JP
 *   when final arrives: reconcile — if final ≈ last partial (≥75% overlap),
 *     keep the speculative EN; else abort it and retranslate the real final.
 *
 * This typically saves 1-2s of wall-clock per utterance (the speculative
 * translation runs concurrently with the Whisper final pass instead of
 * sequentially after it) — at the cost of occasionally wasted Ollama work
 * when the final differs materially from the partial. That's rare with the
 * speed model because partials and finals use the same model.
 *
 * Callbacks:
 *   onSpeechStart({ id })
 *   onPartial({ id, japanese })       — during speech, JP updates
 *   onTranscription({ id, japanese }) — JP locked (may fire twice: once
 *                                       speculatively at silence, then
 *                                       again if Whisper final disagrees)
 *   onTranslation({ id, english, done })
 *   onStateChange(state)  'listening' | 'stopped'
 *   onVolume(0-1)
 *   onError(err)
 *   onDebug(msg)
 */

export class MeetingClient {
  constructor(serverUrl, opts = {}) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.deviceId = opts.deviceId || '';

    this.stream = null;
    this.mediaRecorder = null;
    this.audioContext = null;
    this.analyser = null;

    this._rafId = null;
    this._partialTimer = null;
    this._chunks = [];
    this._isActive = false;
    this._hadSpeech = false;
    this._speechStartEmitted = false;
    this._speechStart = 0;
    this._lastSpeechTime = 0;
    this._nextId = 1;
    this._currentEntryId = null;
    this._partialSeq = 0;
    this._renderedSeq = 0;
    this._partialInFlight = false;
    this._partialStartedAt = 0;  // when _partialInFlight flipped true
    this._mime = '';
    // Most-recent successful partial JP for the current chunk. Captured at
    // silence-cut and used for speculative translation (fires in parallel
    // with the Whisper final pass instead of after it).
    this._lastPartialJP = '';

    // Tunables — defaults tuned for far-field (laptop on a meeting table,
    // speakers 1-3m away). Raise VOICE_THRESHOLD in noisier rooms; lower in
    // very quiet ones. SILENCE_MS is generous so Japanese thinking-pauses
    // don't cut utterances mid-sentence.
    this.VOICE_THRESHOLD = 10;
    this.SILENCE_MS = 1800;
    this.MIN_SPEECH_MS = 500;
    this.MAX_CHUNK_MS = 20000;
    this.PARTIAL_INTERVAL_MS = 1500;  // send live partial this often while speaking

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
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }

  _log(msg) { console.log('[meeting]', msg); this.onDebug?.(msg); }

  // Wrap a fetch with an AbortController timeout so hung server calls can't
  // freeze the client state machine. Without this, a single stalled partial
  // request leaves `_partialInFlight` stuck true and _maybeSendPartial
  // silently drops every subsequent call — the UI "freezes" after a few
  // minutes because the pipeline is deadlocked on one zombie fetch.
  //
  // We DON'T clear the timer on fetch-resolve because fetch resolves on
  // headers, not body. The timer needs to stay armed through the body
  // read (res.json() or res.body.getReader()). Aborting a completed fetch
  // is a no-op, so leaving the timer pending is safe; it just GC's after
  // firing.
  _fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    // If caller already passed a signal, forward aborts from either side.
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
      this.onError?.({ error: 'not-supported', message: 'MediaRecorder not supported.' });
      return;
    }
    if (this._isActive) return;

    try {
      // MEETING = far-field (laptop on table, speakers across the room).
      // Browser DSP (noise suppression / AGC / echo cancellation) is tuned for
      // "one person talking into a phone" and actively hurts far-field capture:
      // quiet voices get gated, noise floor pumps up in pauses, soft syllables
      // get mistaken for echo. Whisper large-v3 handles raw noisy input well —
      // let it do its job.
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

    await this._setupAnalyser();

    this._isActive = true;
    this._startChunk();
    this._startVADLoop();
    this.onStateChange?.('listening');
    this._log('meeting started · live transcription on');
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

        // Emit speech-start the first time we detect speech in this chunk
        if (!this._speechStartEmitted && now - this._speechStart > 150) {
          this._speechStartEmitted = true;
          this._currentEntryId = this._nextId++;
          this._renderedSeq = 0;
          this._partialSeq = 0;
          this._log(`[#${this._currentEntryId}] speech start`);
          this.onSpeechStart?.({ id: this._currentEntryId });
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

      // Watchdog: if a partial has been flagged in-flight longer than any
      // reasonable request, something slipped past the fetch timeout (e.g.
      // a stuck body-read state). Force-reset so the pipeline can recover
      // instead of staying frozen.
      if (this._partialInFlight && this._partialStartedAt &&
          now - this._partialStartedAt > 12000) {
        this._log('[watchdog] partial stuck >12s, force-resetting');
        this._partialInFlight = false;
        this._partialStartedAt = 0;
      }

      // If the AudioContext got suspended (laptop sleep/unplug/tab
      // backgrounding), resume it. Without this, VAD reads all zeros
      // after a wake and we silently stop detecting speech.
      if (this.audioContext && this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(() => {});
      }

      this._rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  // With timeslice-based recording (see _startChunk), ondataavailable fires
  // automatically every PARTIAL_INTERVAL_MS. We trigger sends from there instead.
  _startPartialTicker() { /* noop — see ondataavailable */ }

  _maybeSendPartial() {
    if (!this._isActive) return;
    if (!this._speechStartEmitted) return;
    if (!this._currentEntryId) return;
    if (this._partialInFlight) return;
    if (this._chunks.length === 0) return;

    const entryId = this._currentEntryId;
    const seq = ++this._partialSeq;
    this._partialInFlight = true;
    this._partialStartedAt = performance.now();  // watchdog tracks this

    const blob = new Blob(this._chunks, { type: this._mime || 'audio/webm' });
    this._log(`[#${entryId}] partial send seq=${seq} size=${blob.size}B chunks=${this._chunks.length}`);
    this._sendPartial(entryId, blob, seq);
  }

  async _sendPartial(entryId, blob, seq) {
    const ext = (this._mime || '').includes('mp4') ? 'mp4' : 'webm';
    try {
      const form = new FormData();
      form.append('audio', blob, `partial.${ext}`);
      const t0 = performance.now();
      // Partials always use the fast Japanese-specialized model (kotoba).
      // Results get overwritten by the final pass, so there's no reason to
      // burn Mac mini compute on large-v3 for throwaway mid-utterance passes.
      // 8s cap on partials — kotoba normally returns in 300-800ms. Anything
      // longer means the server is overloaded or the request is stalled;
      // abort so the next partial can go through instead of waiting forever.
      const res = await this._fetchWithTimeout(this.serverUrl + `/transcribe?model=speed`, { method: 'POST', body: form }, 8000);
      const dt = Math.round(performance.now() - t0);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const jp = (data.japanese || '').trim();

      // Drop if a later partial already rendered, or utterance finalized
      if (seq <= this._renderedSeq) return;
      if (entryId !== this._currentEntryId) return;

      this._renderedSeq = seq;
      if (jp) {
        this._log(`[#${entryId} partial ${dt}ms] ${jp.slice(0, 60)}`);
        // Remember this for speculative translation at silence-cut time.
        this._lastPartialJP = jp;
        this.onPartial?.({ id: entryId, japanese: jp });
      }
    } catch (err) {
      this._log(`[#${entryId} partial failed] ${err.message}`);
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
    this._lastPartialJP = '';  // fresh chunk, fresh speculative baseline

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
        // Timeslice-based chunking: after each chunk arrives, try to send a partial.
        // (We only actually send when speech is detected + not already in flight.)
        this._maybeSendPartial();
      }
    };

    this.mediaRecorder.onstop = () => {
      const type = this.mediaRecorder.mimeType || this._mime || 'audio/webm';
      const blob = new Blob(this._chunks, { type });
      const hadSpeech = this._hadSpeech;
      const finalizedEntryId = this._currentEntryId;
      // Snapshot latest partial JP BEFORE _startChunk resets it — this is
      // the baseline for speculative translation.
      const speculativeJP = this._lastPartialJP;

      // Reset state BEFORE any async work — late partials will be dropped
      this._chunks = [];
      this._currentEntryId = null;
      this._renderedSeq = Number.POSITIVE_INFINITY;  // kill late partials

      if (hadSpeech && blob.size > 1000 && finalizedEntryId) {
        this._processFinal(finalizedEntryId, blob, type, speculativeJP);
      }

      if (this._isActive) this._startChunk();
    };

    try {
      // timeslice: auto-fire ondataavailable every PARTIAL_INTERVAL_MS
      this.mediaRecorder.start(this.PARTIAL_INTERVAL_MS);
      this._log(`recorder started, timeslice=${this.PARTIAL_INTERVAL_MS}ms`);
    } catch (e) {
      this._log(`start failed: ${e.message}`);
    }
  }

  _cutChunk(reason) {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this._log(`cut (${reason})`);
      try { this.mediaRecorder.stop(); } catch (e) {}
    }
  }

  // Character-overlap similarity between two JP strings. Used to decide
  // whether the Whisper final is "close enough" to the speculative baseline
  // that we can keep the speculative translation instead of retranslating.
  // Returns 0..1; 1 = identical.
  _similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    // Longest common prefix — a very good proxy because the speed model
    // tends to agree on the beginning and only disagree on trailing words
    // that were mid-articulation during the last partial.
    const minLen = Math.min(a.length, b.length);
    let i = 0;
    while (i < minLen && a[i] === b[i]) i++;
    if (i === minLen) {
      // One is a full prefix of the other — score based on how much of
      // the longer string the shared prefix covers.
      return 0.6 + 0.4 * (minLen / Math.max(a.length, b.length));
    }
    // Diverged before either ran out — fall back to character-set Dice.
    const setA = new Set(a);
    const setB = new Set(b);
    let inter = 0;
    for (const c of setA) if (setB.has(c)) inter++;
    return (2 * inter) / (setA.size + setB.size);
  }

  // Final pass: in parallel runs
  //   (a) Whisper final on the full silence-cut audio
  //   (b) speculative translation on the most-recent partial JP (if any)
  // Then reconciles: accept the speculative translation if the final JP is
  // similar enough (≥0.75); otherwise abort and retranslate.
  async _processFinal(id, blob, type, speculativeJP) {
    const ext = type.includes('webm') ? 'webm' : type.includes('mp4') ? 'mp4' : 'audio';

    // Kick off the speculative translation FIRST so Ollama is already
    // generating by the time Whisper returns. Only do this if the partial
    // is substantial — <5 chars isn't worth the Ollama round-trip.
    let speculativeAbort = null;
    let speculativeFired = false;
    if (speculativeJP && speculativeJP.length >= 5 && this._isActive) {
      // Commit the partial as JP immediately so the user sees it now
      // instead of 1-2s from now when Whisper final lands.
      this.onTranscription?.({ id, japanese: speculativeJP });
      speculativeAbort = new AbortController();
      speculativeFired = true;
      this._log(`[#${id}] speculative on: ${speculativeJP.slice(0, 60)}`);
      // Fire-and-forget — runs in parallel with the Whisper call below.
      // If we decide to abort it after the final arrives, the signal kills it.
      this._translateAsync(id, speculativeJP, { signal: speculativeAbort.signal });
    }

    // Whisper final pass — speed model only. large-v3 adds 1-2s for an
    // accuracy bump that doesn't matter for reading comprehension.
    let japanese = '';
    try {
      const form = new FormData();
      form.append('audio', blob, `final.${ext}`);
      const t0 = performance.now();
      // 15s cap on finals — longer than partials because the full chunk
      // can be up to 20s of audio. Anything beyond 15s = pathological.
      const res = await this._fetchWithTimeout(this.serverUrl + `/transcribe?final=true&model=speed`, { method: 'POST', body: form }, 15000);
      const dt = Math.round(performance.now() - t0);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      japanese = (data.japanese || '').trim();
      if (data.dropped === 'hallucination') {
        this._log(`[#${id} final ${dt}ms] DROPPED as hallucination`);
      } else {
        this._log(`[#${id} final ${dt}ms] ${japanese.slice(0, 80)}`);
      }
    } catch (err) {
      this._log(`[#${id} final failed] ${err.message}`);
      // If we already have speculative translation in flight, let it finish —
      // it's our best shot now that the final errored.
      return;
    }

    // Final came back empty (silence or hallucination filter fired). The
    // speculative was likely working from similar audio — kill it and
    // clear the JP/EN we may have committed.
    if (!japanese) {
      if (speculativeFired) {
        speculativeAbort?.abort();
        this.onTranscription?.({ id, japanese: '' });
        this.onTranslation?.({ id, english: '', done: true });
      }
      return;
    }

    if (!this._isActive) { this._log(`[#${id}] dropped — meeting stopped`); return; }

    // Reconcile speculative vs final
    if (speculativeFired) {
      const sim = this._similarity(japanese, speculativeJP);
      if (sim >= 0.75) {
        // Close enough — speculative translation stands. Update JP to
        // the final (might have a fixed kanji or a trailing particle),
        // but don't retranslate.
        if (japanese !== speculativeJP) {
          this.onTranscription?.({ id, japanese });
        }
        this._log(`[#${id}] speculative kept (sim=${sim.toFixed(2)})`);
        return;
      }
      // Material difference — abort and retranslate.
      this._log(`[#${id}] retranslating (sim=${sim.toFixed(2)})`);
      speculativeAbort?.abort();
      this.onTranscription?.({ id, japanese });
      // Wipe the stale speculative EN so there's no flash of wrong
      // translation before the new stream starts replacing it char-by-char.
      this.onTranslation?.({ id, english: '', done: false });
      this._translateAsync(id, japanese);
    } else {
      // No speculative available — original sequential flow.
      this.onTranscription?.({ id, japanese });
      this._translateAsync(id, japanese);
    }
  }

  async _translateAsync(id, japanese, opts = {}) {
    const signal = opts.signal;
    try {
      const context = this.getContext?.() || [];
      const t0 = performance.now();
      // 30s cap on the translate stream — qwen2.5:1.5b finishes most
      // sentences in 300ms-1s; 30s only fires if Ollama is truly wedged.
      const res = await this._fetchWithTimeout(this.serverUrl + '/translate_stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: japanese, context: context.slice(-5) }),
        signal,
      }, 30000);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let english = '';
      let firstTokenAt = 0;

      while (true) {
        if (signal?.aborted) return;
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
          if (payload.error) { this._log(`[#${id} en error] ${payload.error}`); continue; }
          if (payload.delta) {
            if (!firstTokenAt) firstTokenAt = performance.now();
            english += payload.delta;
            this.onTranslation?.({ id, english: english.trim(), done: false });
          }
          if (payload.done) {
            const total = Math.round(performance.now() - t0);
            const firstT = firstTokenAt ? Math.round(firstTokenAt - t0) : total;
            this._log(`[#${id} en first=${firstT}ms total=${total}ms]`);
            this.onTranslation?.({ id, english: english.trim(), done: true });
            return;
          }
        }
      }
      this.onTranslation?.({ id, english: english.trim(), done: true });
    } catch (err) {
      // AbortError is intentional (speculative got replaced) — silent.
      if (err.name === 'AbortError') {
        this._log(`[#${id}] speculative EN aborted`);
        return;
      }
      this._log(`[#${id} en failed] ${err.message}`);
      this.onTranslation?.({ id, english: '[translation failed]', done: true });
    }
  }

  stop() {
    this._isActive = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch (e) {}
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      try { this.audioContext.close(); } catch (e) {}
      this.audioContext = null;
    }
    this.onVolume?.(0);
    this.onStateChange?.('stopped');
    this._log('meeting stopped');
  }
}
