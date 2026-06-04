export class TTS {
  constructor(lang = 'en-US') {
    this.lang = lang;
    this.synth = window.speechSynthesis;
    this.voice = null;
    this.voiceName = ''; // user-selected voice name
    this.rate = 1.0;
    this.pitch = 1.0;

    if (this.synth.getVoices().length > 0) this._selectVoice();
    this.synth.addEventListener?.('voiceschanged', () => this._selectVoice());
  }

  listVoices() {
    return this.synth.getVoices().filter(v => v.lang.startsWith('en'));
  }

  setVoiceByName(name) {
    this.voiceName = name || '';
    this._selectVoice();
  }

  _selectVoice() {
    const voices = this.synth.getVoices();

    // If user picked a specific voice, use that
    if (this.voiceName) {
      const match = voices.find(v => v.name === this.voiceName);
      if (match) {
        this.voice = match;
        return;
      }
    }

    // Otherwise pick a good default
    const prefs = [
      v => v.name.includes('Samantha'),
      v => v.name.includes('Ava') && v.lang.startsWith('en'),
      v => v.name.includes('Google') && v.lang.startsWith('en'),
      v => v.name.includes('Daniel') && v.lang.startsWith('en'),
      v => v.lang === 'en-US',
      v => v.lang.startsWith('en'),
    ];
    for (const pref of prefs) {
      const match = voices.find(pref);
      if (match) { this.voice = match; return; }
    }
  }

  speak(text) {
    if (!text) return Promise.resolve();

    return new Promise((resolve) => {
      this.synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.lang;
      u.rate = this.rate;
      u.pitch = this.pitch;
      if (this.voice) u.voice = this.voice;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      this.synth.speak(u);
    });
  }

  stop() { this.synth.cancel(); }
}
