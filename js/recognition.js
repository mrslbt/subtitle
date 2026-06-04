export class Recognition {
  constructor(lang = 'ja-JP') {
    this.lang = lang;
    this.recognition = null;
    this.running = false;
    this._shouldRestart = false;
    this._restartDelay = 100; // ms between auto-restarts
    this._restartTimer = null;

    // Callbacks
    this.onResult = null;     // (finalText) => {}
    this.onInterim = null;    // (interimText) => {}
    this.onStateChange = null;
    this.onError = null;

    this._supported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  get supported() { return this._supported; }

  start() {
    if (!this._supported) {
      this.onError?.({ error: 'not-supported', message: 'Speech Recognition is not supported.' });
      return;
    }
    if (this.running) return;

    this._shouldRestart = true;
    this._createAndStart();
  }

  _createAndStart() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SR();
    this.recognition.lang = this.lang;
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;

    this.recognition.onstart = () => {
      this.running = true;
      this.onStateChange?.('listening');
    };

    this.recognition.onresult = (event) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += t;
        else interim += t;
      }

      if (interim) this.onInterim?.(interim);
      if (final) {
        this.onInterim?.(''); // clear interim
        this.onResult?.(final.trim());
      }
    };

    this.recognition.onerror = (event) => {
      // Silence is normal — ignore
      if (event.error === 'no-speech') return;
      // Intentional stop
      if (event.error === 'aborted') return;

      // 'audio-capture' = no mic, 'not-allowed' = blocked
      if (event.error === 'not-allowed' || event.error === 'audio-capture') {
        this._shouldRestart = false;
        this.onError?.({
          error: 'not-allowed',
          message: 'Microphone access denied or unavailable.',
        });
        return;
      }

      // Network / service errors — report but keep trying
      this.onError?.({ error: event.error, message: `Recognition: ${event.error}` });
    };

    this.recognition.onend = () => {
      this.running = false;
      if (this._shouldRestart) {
        // Small delay to avoid rapid-fire restarts
        this._restartTimer = setTimeout(() => {
          if (this._shouldRestart) {
            try {
              this._createAndStart();
            } catch (e) {
              // Fallback — wait longer and retry
              setTimeout(() => {
                if (this._shouldRestart) this._createAndStart();
              }, 500);
            }
          }
        }, this._restartDelay);
      } else {
        this.onStateChange?.('stopped');
      }
    };

    try {
      this.recognition.start();
    } catch (e) {
      // If start fails because it's already running, that's fine
      if (!String(e.message || '').includes('already started')) {
        this.onError?.({ error: 'start-failed', message: 'Failed to start recognition.' });
      }
    }
  }

  stop() {
    this._shouldRestart = false;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this.recognition) {
      try { this.recognition.stop(); } catch (e) {}
      try { this.recognition.abort(); } catch (e) {}
    }
    this.running = false;
  }
}
