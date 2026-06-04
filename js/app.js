import { Recognition } from './recognition.js';
import { WhisperClient } from './whisper.js';
import { MeetingClient } from './meeting.js';
import { RealtimeClient } from './realtime.js';
import { Translator } from './translator.js';
import { TTS } from './tts.js';

// ── Settings ──
const DEFAULTS = {
  engine: 'whisper',
  mode: 'convo',
  serverUrl: 'https://earpiece.marselbait.me',
  voice: '',
  coaching: true,
  debug: false,
  whisperModel: 'accuracy',  // 'accuracy' (large-v3) or 'speed' (kotoba)
  micDeviceId: '',           // '' = auto (prefer built-in, avoid iPhone/Continuity)
  realtimeMode: 'auto',      // 'auto' = use OpenAI realtime if server supports it; 'off' = local Ollama only
};

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('earpiece.settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings(s) { localStorage.setItem('earpiece.settings', JSON.stringify(s)); }

const SESSION_GAP_MS = 5 * 60 * 1000; // 5 minutes → new session

// ── App ──
class App {
  constructor() {
    this.settings = loadSettings();
    this.tts = new TTS('en-US');
    this.translator = new Translator();

    this.engine = null;
    this.active = false;
    this._history = [];  // {jp, en} for context
    this._liveEntry = null;  // DOM element for current in-progress entry
    this._currentSessionHeader = null;
    this._lastEntryTime = 0;
    this._sessionStartTime = 0;
    this._sessionTimerInterval = null;
    this._userScrolledUp = false;
    this._pendingNewCount = 0;
    // Tri-state: null = unknown (not yet checked), true = /health reports
    // realtime_available, false = server has no OpenAI key. Used by
    // _buildEngine to pick RealtimeClient vs MeetingClient.
    this._realtimeAvailable = null;

    this.els = {
      app: document.getElementById('app'),
      ambient: document.getElementById('ambient'),
      transcript: document.getElementById('transcript'),
      emptyState: document.getElementById('empty-state'),
      emptyTitle: document.getElementById('empty-title'),
      emptyHint: document.getElementById('empty-hint'),
      micBtn: document.getElementById('mic-btn'),
      micVu: document.getElementById('mic-vu'),
      micHint: document.getElementById('mic-hint'),
      gearBtn: document.getElementById('gear-btn'),
      sessionTimer: document.getElementById('session-timer'),
      modeConvo: document.getElementById('mode-convo'),
      modeMeeting: document.getElementById('mode-meeting'),
      scrollLatest: document.getElementById('scroll-latest'),
      scrollLatestCount: document.getElementById('scroll-latest-count'),
      toast: document.getElementById('toast'),
      debugLog: document.getElementById('debug-log'),

      // Menu
      menuOverlay: document.getElementById('menu-overlay'),
      menuNewSession: document.getElementById('menu-new-session'),
      menuCopyAll: document.getElementById('menu-copy-all'),
      menuSettings: document.getElementById('menu-settings'),
      menuClearAll: document.getElementById('menu-clear-all'),

      // Settings
      settingsOverlay: document.getElementById('settings-overlay'),
      settingsClose: document.getElementById('settings-close'),
      settingsSave: document.getElementById('settings-save'),
      segWhisper: document.getElementById('seg-whisper'),
      segWeb: document.getElementById('seg-web'),
      engineHint: document.getElementById('engine-hint'),
      segAccuracy: document.getElementById('seg-accuracy'),
      segSpeed: document.getElementById('seg-speed'),
      modelHint: document.getElementById('model-hint'),
      serverGroup: document.getElementById('server-group'),
      serverUrl: document.getElementById('server-url'),
      testServer: document.getElementById('test-server'),
      serverStatus: document.getElementById('server-status'),
      voiceSelect: document.getElementById('voice-select'),
      micSelect: document.getElementById('mic-select'),
      micHintText: document.getElementById('mic-hint-text'),
      coachingToggle: document.getElementById('coaching-toggle'),
      debugToggle: document.getElementById('debug-toggle'),
      glossaryList: document.getElementById('glossary-list'),
      glossaryCount: document.getElementById('glossary-count'),
      glossaryRefresh: document.getElementById('glossary-refresh'),
      glossaryClear: document.getElementById('glossary-clear'),

      // Onboarding
      onboardOverlay: document.getElementById('onboard-overlay'),
      onboardNext: document.getElementById('onboard-next'),

      // Error
      errorOverlay: document.getElementById('error-overlay'),
      errorTitle: document.getElementById('error-title'),
      errorMsg: document.getElementById('error-msg'),
      errorDismiss: document.getElementById('error-dismiss'),
    };

    this._bindUI();
    this._applyMode();
    this._buildEngine();
    this._populateVoices();
    this._checkOnboarding();
    this._applyDebugToggle();
  }

  // ── Engine ──
  _buildEngine() {
    if (this.engine && this.engine.stop) { try { this.engine.stop(); } catch {} }

    const mode = this.settings.mode;

    if (this.settings.engine === 'whisper' && mode === 'meeting') {
      // Default to RealtimeClient (OpenAI gpt-realtime-translate) for
      // meeting mode. Falls back to MeetingClient (local Ollama) if the
      // user explicitly set realtimeMode='off' or the server reports no
      // OPENAI_API_KEY.
      //
      // We pick at build-time based on cached server capability — see
      // _checkRealtimeCapability(). If we haven't checked yet, optimistically
      // start RealtimeClient; if upstream fails it emits an error and the
      // user can flip the setting.
      const wantRealtime = this.settings.realtimeMode !== 'off' &&
        (this._realtimeAvailable !== false);  // null or true → try it
      if (wantRealtime) {
        const m = new RealtimeClient(this.settings.serverUrl, { deviceId: this.settings.micDeviceId });
        m.onSpeechStart = ({ id }) => this._onSpeechStart(id);
        m.onPartial = ({ id, japanese }) => this._onPartialTranscription(id, japanese);
        m.onTranscription = ({ id, japanese }) => this._onTranscription(id, japanese);
        m.onTranslation = ({ id, english, done }) => this._onTranslation(id, english, done);
        m.onStateChange = (s) => this._onEngineState(s);
        m.onError = (e) => this._onError(e);
        m.onVolume = (v) => this._updateVolume(v);
        m.onDebug = (msg) => this._debug(msg);
        m.getContext = () => this._history;
        this.engine = m;
      } else {
        const m = new MeetingClient(this.settings.serverUrl, { deviceId: this.settings.micDeviceId });
        m.onSpeechStart = ({ id }) => this._onSpeechStart(id);
        m.onPartial = ({ id, japanese }) => this._onPartialTranscription(id, japanese);
        m.onTranscription = ({ id, japanese }) => this._onTranscription(id, japanese);
        m.onTranslation = ({ id, english, done }) => this._onTranslation(id, english, done);
        m.onStateChange = (s) => this._onEngineState(s);
        m.onError = (e) => this._onError(e);
        m.onVolume = (v) => this._updateVolume(v);
        m.onDebug = (msg) => this._debug(msg);
        m.getContext = () => this._history;
        m.modelPref = this.settings.whisperModel || 'accuracy';
        this.engine = m;
      }
      // Fire-and-forget capability check so subsequent rebuilds pick correctly.
      this._checkRealtimeCapability();
    } else if (this.settings.engine === 'whisper') {
      const w = new WhisperClient(this.settings.serverUrl, { deviceId: this.settings.micDeviceId });
      w.onStart = () => this._onConvoStart();
      w.onResult = ({ japanese, english }) => this._onConvoResult(japanese, english);
      w.onPartial = ({ japanese, english }) => this._onConvoPartial(japanese, english);
      w.onStateChange = (s) => this._onEngineState(s);
      w.onError = (e) => this._onError(e);
      w.onVolume = (v) => this._updateVolume(v);
      w.onDuration = (ms, max) => this._updateDuration(ms, max);
      w.onDebug = (msg) => this._debug(msg);
      w.getContext = () => this._history;
      w.modelPref = this.settings.whisperModel || 'accuracy';
      this.engine = w;
    } else {
      const r = new Recognition('ja-JP');
      r.onResult = (text) => this._onWebFinal(text);
      r.onStateChange = (s) => this._onEngineState(s);
      r.onError = (e) => this._onError(e);
      this.engine = r;
    }
  }

  _bindUI() {
    this.els.micBtn.addEventListener('click', () => this._toggle());
    this.els.gearBtn.addEventListener('click', () => this._openMenu());

    this.els.modeConvo.addEventListener('click', () => this._setMode('convo'));
    this.els.modeMeeting.addEventListener('click', () => this._setMode('meeting'));

    // Menu items
    this.els.menuOverlay.addEventListener('click', (e) => {
      if (e.target === this.els.menuOverlay) this._closeMenu();
    });
    this.els.menuNewSession.addEventListener('click', () => {
      this._closeMenu();
      this._startNewSession(true);
    });
    this.els.menuCopyAll.addEventListener('click', () => {
      this._closeMenu();
      this._copyTranscript();
    });
    this.els.menuSettings.addEventListener('click', () => {
      this._closeMenu();
      this._openSettings();
    });
    this.els.menuClearAll.addEventListener('click', () => {
      this._closeMenu();
      this._confirmClearAll();
    });

    // Settings
    this.els.settingsClose.addEventListener('click', () => this._closeSettings());
    this.els.settingsSave.addEventListener('click', () => this._saveSettings());
    this.els.segWhisper.addEventListener('click', () => this._pickEngineUI('whisper'));
    this.els.segWeb.addEventListener('click', () => this._pickEngineUI('web'));
    this.els.segAccuracy?.addEventListener('click', () => this._pickModelUI('accuracy'));
    this.els.segSpeed?.addEventListener('click', () => this._pickModelUI('speed'));
    this.els.testServer.addEventListener('click', () => this._testServer());

    // Glossary
    this.els.glossaryRefresh?.addEventListener('click', () => this._loadGlossary());
    this.els.glossaryClear?.addEventListener('click', () => this._clearGlossary());

    // Error
    this.els.errorDismiss.addEventListener('click', () => {
      this.els.errorOverlay.classList.remove('visible');
    });

    // Onboarding
    this.els.onboardNext.addEventListener('click', () => this._onboardNext());

    // Scroll detection — show "scroll to latest" pill
    this.els.transcript.addEventListener('scroll', () => this._checkScroll());
    this.els.scrollLatest.addEventListener('click', () => this._scrollToLatest());

    // Apply saved mode to UI
    this.els.modeConvo.classList.toggle('active', this.settings.mode === 'convo');
    this.els.modeMeeting.classList.toggle('active', this.settings.mode === 'meeting');
  }

  // ── Mode ──
  _setMode(mode) {
    if (this.active) this._stop();
    this.settings.mode = mode;
    saveSettings(this.settings);
    this.els.modeConvo.classList.toggle('active', mode === 'convo');
    this.els.modeMeeting.classList.toggle('active', mode === 'meeting');
    this._applyMode();
    this._buildEngine();
    this._haptic(10);
  }

  _applyMode() {
    const mode = this.settings.mode;
    this.els.app.classList.toggle('meeting-active', false);  // only true while recording
    if (mode === 'convo') {
      this.els.emptyTitle.textContent = 'Ready to listen';
      this.els.emptyHint.textContent = 'Tap the mic. Talk in Japanese. Hear it back in English.';
      this.els.micHint.textContent = 'Tap to record';
    } else {
      this.els.emptyTitle.textContent = 'Start a meeting';
      this.els.emptyHint.textContent = 'Tap once, let it run. Japanese appears live, English fills in as it translates.';
      this.els.micHint.textContent = 'Tap to start meeting';
    }
  }

  // ── Mic toggle ──
  _toggle() {
    this._haptic(15);
    if (this.active) this._stop();
    else this._start();
  }

  async _start() {
    this.active = true;
    this.els.micBtn.classList.add('active');
    this._setAmbient('recording');
    this.els.micHint.textContent = this.settings.mode === 'convo'
      ? 'Tap again to translate'
      : 'Tap to stop';

    // Meeting mode: start session timer
    if (this.settings.mode === 'meeting') {
      this.els.app.classList.add('meeting-active');
      this._startSessionTimer();
      this._maybeStartNewSession();
    }

    // Convo: create a placeholder live entry
    if (this.settings.mode === 'convo') {
      this._maybeStartNewSession();
      this._liveEntry = this._createPlaceholderEntry();
    }

    this.engine.start();
  }

  _stop() {
    this.active = false;
    this.els.micBtn.classList.remove('active');
    this._setAmbient('');
    this.els.micHint.textContent = this.settings.mode === 'convo' ? 'Tap to record' : 'Tap to start meeting';
    this.els.app.classList.remove('meeting-active');
    this._stopSessionTimer();
    if (this.engine?.stop) this.engine.stop();
    this.tts.stop();
    this._updateVolume(0);

    // If convo placeholder never got content, remove it
    if (this._liveEntry) {
      const jp = this._liveEntry.querySelector('.t-jp')?.textContent?.trim();
      if (!jp) {
        this._liveEntry.remove();
      }
      this._liveEntry = null;
    }
    this._updateEmptyState();
  }

  // ── Session management ──
  _maybeStartNewSession() {
    const now = Date.now();
    if (now - this._lastEntryTime > SESSION_GAP_MS || !this._currentSessionHeader) {
      this._startNewSession(false);
    }
  }

  _startNewSession(showToast) {
    this._sessionStartTime = Date.now();
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const header = document.createElement('div');
    header.className = 'session-header';
    header.textContent = `Session · ${time}`;
    header.dataset.session = String(this._sessionStartTime);
    this.els.transcript.appendChild(header);
    this._currentSessionHeader = header;
    this._scrollToLatest();
    if (showToast) this._toast('New session started');
    this._updateEmptyState();
  }

  _startSessionTimer() {
    const start = Date.now();
    const fmt = (ms) => {
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const sec = s % 60;
      const h = Math.floor(m / 60);
      if (h > 0) return `${h}:${String(m % 60).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
      return `${m}:${String(sec).padStart(2,'0')}`;
    };
    const update = () => {
      this.els.sessionTimer.textContent = `● Recording · ${fmt(Date.now() - start)}`;
    };
    update();
    this._sessionTimerInterval = setInterval(update, 1000);
  }

  _stopSessionTimer() {
    if (this._sessionTimerInterval) {
      clearInterval(this._sessionTimerInterval);
      this._sessionTimerInterval = null;
    }
    this.els.sessionTimer.textContent = '';
  }

  // ── Entry creation / update ──
  _createPlaceholderEntry(id) {
    const div = document.createElement('div');
    div.className = 't-entry live placeholder';
    if (id) div.dataset.id = String(id);
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
      <div class="t-jp"></div>
      <div class="t-en"></div>
      <div class="t-meta">
        <span>${time}</span>
        <span class="tts-indicator">
          <span class="wave"></span><span class="wave"></span><span class="wave"></span>
          <span>Speaking</span>
        </span>
      </div>
    `;
    this.els.transcript.appendChild(div);
    this._updateEmptyState();
    if (!this._userScrolledUp) this._scrollToLatest();
    return div;
  }

  _updateEmptyState() {
    const hasEntries = this.els.transcript.querySelector('.t-entry') != null;
    this.els.emptyState.style.display = hasEntries ? 'none' : 'block';
  }

  // ── Convo mode handlers ──

  // Fires when recording begins — create placeholder entry immediately
  _onConvoStart() {
    this._maybeStartNewSession();
    if (!this._liveEntry) {
      this._liveEntry = this._createPlaceholderEntry();
    }
    this._liveEntry.classList.add('transcribing');
    this._setAmbient('recording');
  }

  _onConvoPartial(jp, en) {
    if (!this._liveEntry) this._liveEntry = this._createPlaceholderEntry();
    if (jp) {
      this._liveEntry.classList.remove('placeholder');
      const jpEl = this._liveEntry.querySelector('.t-jp');
      if (jpEl) this._setJpTypewriter(jpEl, jp);
    }
    const enEl = this._liveEntry.querySelector('.t-en');
    if (enEl && en !== undefined) {
      enEl.textContent = en;
      if (en) {
        // JP is now final, EN is streaming
        this._liveEntry.classList.remove('transcribing');
        this._liveEntry.classList.add('translating');
      }
    }
    this._setAmbient(en ? 'translating' : 'recording');
    if (!this._userScrolledUp) this._scrollToLatest();
  }

  async _onConvoResult(jp, en) {
    if (!this._liveEntry) this._liveEntry = this._createPlaceholderEntry();
    this._liveEntry.classList.remove('placeholder', 'translating');
    const jpEl = this._liveEntry.querySelector('.t-jp');
    const enEl = this._liveEntry.querySelector('.t-en');
    if (jpEl) jpEl.textContent = jp;
    if (enEl) enEl.textContent = en;

    const finishedEntry = this._liveEntry;

    // Speak in convo mode only. Meeting mode must never trigger TTS —
    // the laptop is sitting on the conference table, nobody wants it
    // dubbing over the actual meeting.
    if (this.settings.mode === 'convo') {
      this._setAmbient('speaking');
      finishedEntry.classList.add('speaking');
      try { await this.tts.speak(en); } catch {}
      finishedEntry.classList.remove('speaking');
    }

    // Done — convert from live to regular
    finishedEntry.classList.remove('live');
    this._liveEntry = null;
    this._lastEntryTime = Date.now();

    // Save context
    if (jp && en) {
      this._history.push({ jp, en });
      if (this._history.length > 10) this._history.shift();
    }

    // Return to idle state
    this.active = false;
    this.els.micBtn.classList.remove('active');
    this.els.micHint.textContent = 'Tap to record';
    this._setAmbient('');

    this._annotateKeigo(finishedEntry, jp);
    if (this.settings.coaching) {
      this._addReplyButton(finishedEntry, jp);
    }
  }

  // ── Meeting mode handlers ──

  // Fires as soon as speech is detected → create empty placeholder entry
  _onSpeechStart(id) {
    this._maybeStartNewSession();
    const div = this._createPlaceholderEntry(id);
    div.classList.add('transcribing');  // JP is still being built
    this._lastEntryTime = Date.now();
    if (this._userScrolledUp) {
      this._pendingNewCount++;
      this._updateScrollPill();
    }
  }

  // Live partial JP while the user is speaking → update the placeholder
  _onPartialTranscription(id, japanese) {
    const entry = this.els.transcript.querySelector(`[data-id="${id}"]`);
    if (!entry) {
      // No entry yet (shouldn't happen, but be defensive) — create one
      this._onSpeechStart(id);
      return this._onPartialTranscription(id, japanese);
    }
    entry.classList.remove('placeholder');
    const jpEl = entry.querySelector('.t-jp');
    if (jpEl) this._setJpTypewriter(jpEl, japanese);
    // Auto-scroll to latest if user hasn't scrolled up
    if (!this._userScrolledUp) this._scrollToLatest();
  }

  // Final JP after silence → lock it in, translation starts next
  _onTranscription(id, japanese) {
    let entry = this.els.transcript.querySelector(`[data-id="${id}"]`);
    if (!entry) {
      // Utterance was too short for partials to fire — create fresh entry
      this._maybeStartNewSession();
      entry = this._createPlaceholderEntry(id);
    }
    entry.classList.remove('placeholder', 'transcribing');
    entry.classList.add('translating');  // EN is now pending
    const jpEl = entry.querySelector('.t-jp');
    if (jpEl) this._setJpTypewriter(jpEl, japanese, /* final */ true);
    this._lastEntryTime = Date.now();
  }

  // Typewriter effect: when new text extends old text, reveal new chars over time.
  // When text diverges (Whisper corrected earlier words), swap instantly.
  _setJpTypewriter(el, newText, isFinal = false) {
    const oldText = el.textContent || '';
    if (el._typewriterTimer) {
      clearInterval(el._typewriterTimer);
      el._typewriterTimer = null;
    }
    if (newText === oldText) return;
    if (!newText.startsWith(oldText) || isFinal) {
      // Either a correction, or the final — swap directly (but keep smooth)
      el.textContent = newText;
      return;
    }
    // Animate new characters in (~25ms per char = live typing feel)
    const baseLen = oldText.length;
    const addition = newText.slice(baseLen);
    let i = 0;
    el._typewriterTimer = setInterval(() => {
      i++;
      el.textContent = oldText + addition.slice(0, i);
      if (i >= addition.length) {
        clearInterval(el._typewriterTimer);
        el._typewriterTimer = null;
      }
    }, 25);
  }

  _onTranslation(id, english, done) {
    const entry = this.els.transcript.querySelector(`[data-id="${id}"]`);
    if (!entry) return;
    const enEl = entry.querySelector('.t-en');
    if (enEl) enEl.textContent = english;
    if (done) {
      entry.classList.remove('translating', 'live');
      const jp = entry.querySelector('.t-jp')?.textContent || '';
      if (jp && english) {
        this._history.push({ jp, en: english });
        if (this._history.length > 10) this._history.shift();
      }
      this._annotateKeigo(entry, jp);
      if (this.settings.coaching) {
        this._addReplyButton(entry, jp);
      }
    }
  }

  _onWebFinal(text) {
    // Stub: Web Speech API mode — keep simple, route to translator then display
    if (!text.trim()) return;
    const div = this._createPlaceholderEntry();
    div.classList.remove('placeholder');
    div.querySelector('.t-jp').textContent = text;
    (async () => {
      const en = await this.translator.translate(text);
      div.querySelector('.t-en').textContent = en;
      div.classList.remove('live');
      this._history.push({ jp: text, en });
      if (this._history.length > 10) this._history.shift();
      if (this.settings.mode === 'convo') {
        try { await this.tts.speak(en); } catch {}
      }
    })();
  }

  // ── Response coaching (opt-in per entry) ──
  _addReplyButton(entry, jp) {
    if (!jp) return;
    if (entry.querySelector('.suggest-btn') || entry.querySelector('.t-coaching')) return;
    const btn = document.createElement('button');
    btn.className = 'suggest-btn';
    btn.type = 'button';
    btn.innerHTML = `<span class="arrow">↳</span> SUGGEST REPLIES`;
    btn.addEventListener('click', () => this._onSuggestClick(entry, jp, btn));
    entry.appendChild(btn);
  }

  async _onSuggestClick(entry, jp, btn) {
    this._haptic(8);
    btn.disabled = true;
    btn.classList.add('loading');
    btn.innerHTML = `<span class="arrow">↳</span> THINKING…`;
    try {
      const res = await fetch(this.settings.serverUrl + '/suggest_replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: jp, context: this._history.slice(-5) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const suggestions = data.suggestions || [];
      if (suggestions.length === 0) {
        btn.innerHTML = `<span class="arrow">↳</span> NO SUGGESTIONS`;
        return;
      }
      btn.remove();
      this._renderCoaching(entry, suggestions);
    } catch (err) {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.innerHTML = `<span class="arrow">↳</span> RETRY`;
    }
  }

  // ── Keigo (register) detection ──
  _detectKeigo(jp) {
    if (!jp) return null;
    // Strip spaces/punctuation for pattern matching
    const t = jp.replace(/\s+/g, '');
    // Sonkeigo — respectful (other's actions)
    if (/いらっしゃ|ご覧になる|召し上がる|なさい|なさる|おっしゃ|くださ|お待ちに|お帰りに|お話しに|ご存じ/.test(t)) {
      return { level: 'sonkeigo', label: 'RESPECTFUL' };
    }
    // Kenjougo — humble (own actions)
    if (/いたし|申し上げ|参り|伺い|拝見|お目にかか|させていただ/.test(t)) {
      return { level: 'kenjougo', label: 'HUMBLE' };
    }
    // Teineigo — polite (です/ます)
    if (/ですか?$|ます[かねよ]?$|ました$|ません$|でしょう$|ございま/.test(t)) {
      return { level: 'polite', label: 'POLITE' };
    }
    // Casual / slangy markers (includes plain-form endings: だ、た、よ、ね etc.)
    if (/だよ|だね|じゃん|ちゃう|やん|ねん$|ぞ$|わ$|かな?$|[ったるないい]よ$|[ったるないい]ね$|[かやな]$/.test(t)) {
      return { level: 'casual', label: 'CASUAL' };
    }
    return null;
  }

  _annotateKeigo(entry, jp) {
    if (!entry || entry.querySelector('.keigo-badge')) return;
    const k = this._detectKeigo(jp);
    if (!k) return;
    const meta = entry.querySelector('.t-meta > span:first-child');
    if (!meta) return;
    const badge = document.createElement('span');
    badge.className = `keigo-badge keigo-${k.level}`;
    badge.textContent = k.label;
    meta.parentNode.appendChild(badge);
  }

  async _fetchCoaching(entry, jp) {
    // Kept for back-compat but no longer auto-called
    try {
      const res = await fetch(this.settings.serverUrl + '/suggest_replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: jp, context: this._history.slice(-5) }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const suggestions = data.suggestions || [];
      if (suggestions.length === 0) return;
      this._renderCoaching(entry, suggestions);
    } catch {}
  }

  _renderCoaching(afterEntry, suggestions) {
    const card = document.createElement('div');
    card.className = 't-coaching';
    card.innerHTML = `
      <div class="t-coaching-title">💬 Ways to reply</div>
      <div class="t-coaching-list"></div>
    `;
    const list = card.querySelector('.t-coaching-list');
    suggestions.slice(0, 3).forEach((s) => {
      const btn = document.createElement('button');
      btn.className = 't-suggestion';
      btn.innerHTML = `
        <div class="sug-jp">${this._esc(s.jp || '')}</div>
        <div class="sug-meta">
          <span class="sug-romaji">${this._esc(s.romaji || '')}</span>
          <span class="sug-meaning">${this._esc(s.meaning || '')}</span>
        </div>
      `;
      btn.addEventListener('click', () => this._speakJapanese(s.jp));
      list.appendChild(btn);
    });
    // Insert AFTER the entry so it shows just below it
    if (afterEntry.nextSibling) {
      afterEntry.parentNode.insertBefore(card, afterEntry.nextSibling);
    } else {
      afterEntry.parentNode.appendChild(card);
    }
    if (!this._userScrolledUp) this._scrollToLatest();
  }

  async _speakJapanese(text) {
    // Speak Japanese through the phone's main speaker for the other person
    this._haptic(20);
    this._toast('Playing in Japanese…');
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const voices = synth.getVoices();
      const jpVoice = voices.find(v => v.lang.startsWith('ja'));
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      u.rate = 0.95;
      if (jpVoice) u.voice = jpVoice;
      synth.speak(u);
    } catch (e) {
      this._toast('Could not play');
    }
  }

  // ── State / UI helpers ──
  _setAmbient(state) {
    this.els.ambient.className = 'ambient ' + (state || '');
  }

  _updateVolume(v) {
    if (this.els.micVu) this.els.micVu.style.setProperty('--v', String(v));
  }

  _onEngineState(state) {
    if (state === 'listening' && this.active) this._setAmbient('recording');
    else if (state === 'translating') this._setAmbient('translating');
  }

  _onError(err) {
    console.error('[engine]', err);
    this._setAmbient('error');
    if (err.error === 'not-allowed') {
      this._stop();
      this._showError('Microphone blocked', err.message || 'Allow mic access and reload.');
    } else if (err.error === 'server') {
      this._showError("Can't reach server", err.message);
    } else if (err.error === 'not-supported') {
      this._showError('Not supported', err.message);
    }
  }

  _showError(title, msg) {
    this.els.errorTitle.textContent = title;
    this.els.errorMsg.textContent = msg;
    this.els.errorOverlay.classList.add('visible');
  }

  _toast(msg, duration = 2000) {
    this.els.toast.textContent = msg;
    this.els.toast.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.els.toast.classList.remove('visible');
    }, duration);
  }

  _haptic(ms) {
    try { navigator.vibrate?.(ms); } catch {}
  }

  // ── Scroll handling (newest at bottom) ──
  _checkScroll() {
    const t = this.els.transcript;
    // Near bottom = at latest
    const distFromBottom = t.scrollHeight - t.clientHeight - t.scrollTop;
    const atLatest = distFromBottom < 40;
    this._userScrolledUp = !atLatest;
    if (atLatest) {
      this._pendingNewCount = 0;
      this._updateScrollPill();
    }
  }

  _scrollToLatest() {
    const t = this.els.transcript;
    t.scrollTo({ top: t.scrollHeight, behavior: 'smooth' });
    this._pendingNewCount = 0;
    this._userScrolledUp = false;
    this._updateScrollPill();
  }

  _updateScrollPill() {
    if (this._userScrolledUp && this._pendingNewCount > 0) {
      this.els.scrollLatestCount.textContent = `${this._pendingNewCount} new`;
      this.els.scrollLatest.classList.add('visible');
    } else {
      this.els.scrollLatest.classList.remove('visible');
    }
  }

  // ── Menu ──
  _openMenu() { this.els.menuOverlay.classList.add('visible'); }
  _closeMenu() { this.els.menuOverlay.classList.remove('visible'); }

  _confirmClearAll() {
    if (!confirm('Clear all transcript history? This cannot be undone.')) return;
    this.els.transcript.querySelectorAll('.t-entry, .session-header, .t-coaching').forEach(el => el.remove());
    this._history = [];
    this._currentSessionHeader = null;
    this._lastEntryTime = 0;
    this._updateEmptyState();
    this._toast('Cleared');
  }

  _copyTranscript() {
    const lines = [];
    // Read from bottom of DOM up (oldest first for natural reading order)
    const children = Array.from(this.els.transcript.children).reverse();
    for (const el of children) {
      if (el.classList.contains('session-header')) {
        lines.push('');
        lines.push('─── ' + el.textContent + ' ───');
      } else if (el.classList.contains('t-entry')) {
        const jp = el.querySelector('.t-jp')?.textContent || '';
        const en = el.querySelector('.t-en')?.textContent || '';
        const time = el.querySelector('.t-meta span')?.textContent || '';
        if (jp || en) lines.push(`[${time}] ${jp}\n       → ${en}`);
      }
    }
    const text = lines.join('\n').trim();
    if (!text) { this._toast('Nothing to copy'); return; }
    navigator.clipboard?.writeText(text).then(
      () => this._toast('Copied to clipboard'),
      () => this._toast('Copy failed')
    );
  }

  // ── Settings ──
  _openSettings() {
    this.els.serverUrl.value = this.settings.serverUrl;
    this._pickEngineUI(this.settings.engine);
    this._pickModelUI(this.settings.whisperModel || 'accuracy');
    this.els.voiceSelect.value = this.settings.voice || '';
    this.els.coachingToggle.checked = this.settings.coaching;
    this.els.debugToggle.checked = this.settings.debug;
    this.els.settingsOverlay.classList.add('visible');
    this._loadGlossary();
    this._populateMics();
  }

  _applyModelPref() {
    // Push current model preference to whichever engine is active
    if (this.engine && 'modelPref' in this.engine) {
      this.engine.modelPref = this.settings.whisperModel || 'accuracy';
    }
  }

  // Query /health once per session to learn whether the server has the
  // OpenAI key wired up. Result is cached so subsequent _buildEngine
  // calls pick the right client without an extra HTTP round-trip.
  async _checkRealtimeCapability() {
    // Already checked, or check in flight.
    if (this._realtimeAvailable !== null) return this._realtimeAvailable;
    if (this._realtimeCheckPromise) return this._realtimeCheckPromise;
    this._realtimeCheckPromise = (async () => {
      try {
        const res = await fetch(this.settings.serverUrl + '/health', {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        this._realtimeAvailable = !!data.realtime_available;
        this._debug(`[realtime check] available=${this._realtimeAvailable}`);
        // If we picked the wrong engine optimistically and the meeting
        // isn't running yet, rebuild now that we know.
        if (!this.active && this.settings.mode === 'meeting' &&
            this.settings.engine === 'whisper') {
          const expectRealtime = this.settings.realtimeMode !== 'off' && this._realtimeAvailable;
          const isRealtime = this.engine?.constructor?.name === 'RealtimeClient';
          if (expectRealtime !== isRealtime) {
            this._buildEngine();
          }
        }
        return this._realtimeAvailable;
      } catch (err) {
        this._debug(`[realtime check] failed: ${err.message}`);
        this._realtimeAvailable = false;
        return false;
      } finally {
        this._realtimeCheckPromise = null;
      }
    })();
    return this._realtimeCheckPromise;
  }

  // ── Glossary ──
  async _loadGlossary() {
    if (!this.els.glossaryList) return;
    this.els.glossaryList.innerHTML = '<div class="glossary-empty">Loading…</div>';
    try {
      const res = await fetch(this.settings.serverUrl + '/glossary');
      const data = await res.json();
      const items = data.items || [];
      if (this.els.glossaryCount) {
        this.els.glossaryCount.textContent = items.length ? `${items.length} terms` : 'empty';
      }
      if (items.length === 0) {
        this.els.glossaryList.innerHTML = '<div class="glossary-empty">No terms yet. Names &amp; places will auto-populate as you talk.</div>';
        return;
      }
      this.els.glossaryList.innerHTML = items.map(it => `
        <div class="glossary-item">
          <span class="glossary-term">${this._esc(it.term)}</span>
          <span class="glossary-count">×${it.count || 1}</span>
          <button class="glossary-delete" data-term="${this._esc(it.term)}" aria-label="Delete ${this._esc(it.term)}">×</button>
        </div>
      `).join('');
      this.els.glossaryList.querySelectorAll('.glossary-delete').forEach(btn => {
        btn.addEventListener('click', () => this._deleteGlossaryTerm(btn.dataset.term));
      });
    } catch (err) {
      this.els.glossaryList.innerHTML = '<div class="glossary-empty">Can\'t reach server</div>';
    }
  }

  async _deleteGlossaryTerm(term) {
    try {
      await fetch(this.settings.serverUrl + '/glossary/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term }),
      });
      this._loadGlossary();
    } catch {}
  }

  async _clearGlossary() {
    if (!confirm('Clear all glossary terms? This cannot be undone.')) return;
    try {
      await fetch(this.settings.serverUrl + '/glossary/clear', { method: 'POST' });
      this._loadGlossary();
      this._toast('Glossary cleared');
    } catch {}
  }
  _closeSettings() {
    this.els.settingsOverlay.classList.remove('visible');
    this.els.serverStatus.textContent = '';
    this.els.serverStatus.className = 'settings-status';
  }
  _pickEngineUI(engine) {
    this.els.segWhisper.classList.toggle('active', engine === 'whisper');
    this.els.segWeb.classList.toggle('active', engine === 'web');
    this.els.serverGroup.style.display = engine === 'whisper' ? 'flex' : 'none';
    this.els.engineHint.textContent = engine === 'whisper'
      ? 'Runs Whisper on your Mac mini. Best quality.'
      : 'Uses browser speech API. Works offline, lower quality.';
    this._pendingEngine = engine;
  }
  _pickModelUI(model) {
    this.els.segAccuracy?.classList.toggle('active', model === 'accuracy');
    this.els.segSpeed?.classList.toggle('active', model === 'speed');
    if (this.els.modelHint) {
      this.els.modelHint.textContent = model === 'accuracy'
        ? 'Large-v3 — best for quiet speech & names.'
        : 'Kotoba-distil — ~2× faster, slight accuracy drop.';
    }
    this._pendingModel = model;
  }
  _saveSettings() {
    const next = {
      ...this.settings,
      engine: this._pendingEngine || this.settings.engine,
      whisperModel: this._pendingModel || this.settings.whisperModel || 'accuracy',
      serverUrl: (this.els.serverUrl.value || DEFAULTS.serverUrl).trim().replace(/\/$/, ''),
      voice: this.els.voiceSelect.value || '',
      micDeviceId: this.els.micSelect?.value || '',
      coaching: this.els.coachingToggle.checked,
      debug: this.els.debugToggle.checked,
    };
    const engineChanged =
      next.engine !== this.settings.engine ||
      next.serverUrl !== this.settings.serverUrl ||
      next.micDeviceId !== this.settings.micDeviceId;
    this.settings = next;
    saveSettings(next);
    this.tts.setVoiceByName(next.voice);
    this._applyDebugToggle();
    this._applyModelPref();
    if (engineChanged) {
      if (this.active) this._stop();
      this._buildEngine();
    }
    this._closeSettings();
    this._toast('Settings saved');
  }
  async _testServer() {
    const url = this.els.serverUrl.value.trim().replace(/\/$/, '') || DEFAULTS.serverUrl;
    this.els.serverStatus.textContent = 'Testing…';
    this.els.serverStatus.className = 'settings-status';
    try {
      const res = await fetch(url + '/health', { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.els.serverStatus.textContent = `✓ ${data.ollama_model || data.model?.split('/').pop() || 'connected'}`;
      this.els.serverStatus.className = 'settings-status ok';
    } catch (err) {
      this.els.serverStatus.textContent = `✗ ${err.message}`;
      this.els.serverStatus.className = 'settings-status err';
    }
  }

  _populateVoices() {
    const render = () => {
      const voices = this.tts.listVoices();
      this.els.voiceSelect.innerHTML = '<option value="">Auto</option>' +
        voices.map(v => `<option value="${this._esc(v.name)}">${this._esc(v.name)} · ${v.lang}</option>`).join('');
      if (this.settings.voice) {
        this.els.voiceSelect.value = this.settings.voice;
        this.tts.setVoiceByName(this.settings.voice);
      }
    };
    render();
    if (speechSynthesis) speechSynthesis.addEventListener?.('voiceschanged', render);
  }

  // Enumerate audio inputs, populate the mic picker, flag Continuity hijacks.
  // Browser labels are only populated after mic permission has been granted;
  // if they're blank we briefly request a stream to unlock them.
  async _populateMics() {
    const sel = this.els.micSelect;
    const hint = this.els.micHintText;
    if (!sel || !navigator.mediaDevices?.enumerateDevices) return;

    const isContinuity = (label) => /iphone|ipad|continuity/i.test(label || '');
    const isBuiltIn    = (label) => /macbook|built[-\s]?in|internal/i.test(label || '');

    let inputs = [];
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      inputs = devices.filter(d => d.kind === 'audioinput');
      if (inputs.some(d => !d.label)) {
        // Labels blank → no permission yet. Ask briefly then re-enumerate.
        try {
          const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
          tmp.getTracks().forEach(t => t.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
          inputs = devices.filter(d => d.kind === 'audioinput');
        } catch {
          // User denied — leave labels blank, dropdown will show short IDs
        }
      }
    } catch (err) {
      sel.innerHTML = '<option value="">(can\'t enumerate mics)</option>';
      if (hint) hint.textContent = `Enumerate failed: ${err.message}`;
      return;
    }

    const opts = ['<option value="">Auto (browser default)</option>'];
    inputs.forEach(d => {
      const label = d.label || `Input ${d.deviceId.slice(0, 8)}`;
      opts.push(`<option value="${this._esc(d.deviceId)}">${this._esc(label)}</option>`);
    });
    sel.innerHTML = opts.join('');

    // Choose what to preselect
    if (this.settings.micDeviceId && inputs.some(d => d.deviceId === this.settings.micDeviceId)) {
      sel.value = this.settings.micDeviceId;
    } else {
      const preferred = inputs.find(d => isBuiltIn(d.label));
      sel.value = preferred ? preferred.deviceId : '';
    }

    // Warn if the current selection is a Continuity device
    if (hint) {
      const pick = inputs.find(d => d.deviceId === sel.value);
      const suspicious = pick && isContinuity(pick.label);
      hint.textContent = suspicious
        ? '⚠️ Continuity Mic selected. Switch to a MacBook input so your iPhone stops getting hijacked.'
        : 'Pin a specific mic so macOS Continuity doesn\'t grab your iPhone when it\'s nearby.';
      hint.classList.toggle('warn', !!suspicious);
    }

    // Live-update the warning when the user changes selection in the dropdown
    sel.onchange = () => {
      if (!hint) return;
      const pick = inputs.find(d => d.deviceId === sel.value);
      const suspicious = pick && isContinuity(pick.label);
      hint.textContent = suspicious
        ? '⚠️ Continuity Mic selected. Switch to a MacBook input so your iPhone stops getting hijacked.'
        : 'Pin a specific mic so macOS Continuity doesn\'t grab your iPhone when it\'s nearby.';
      hint.classList.toggle('warn', !!suspicious);
    };
  }

  _applyDebugToggle() {
    this.els.debugLog.classList.toggle('visible', !!this.settings.debug);
  }

  _debug(msg) {
    if (!this.settings.debug) return;
    const line = document.createElement('div');
    const t = new Date();
    const stamp = `${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
    line.textContent = `[${stamp}] ${msg}`;
    this.els.debugLog.appendChild(line);
    while (this.els.debugLog.childElementCount > 30) {
      this.els.debugLog.removeChild(this.els.debugLog.firstChild);
    }
    this.els.debugLog.scrollTop = this.els.debugLog.scrollHeight;
  }

  // ── Onboarding ──
  _checkOnboarding() {
    if (localStorage.getItem('earpiece.onboarded')) return;
    this.els.onboardOverlay.classList.add('visible');
    this._onboardStep = 0;
    this._renderOnboard();
  }

  _renderOnboard() {
    const steps = this.els.onboardOverlay.querySelectorAll('.onboard-step');
    const dots = this.els.onboardOverlay.querySelectorAll('.onboard-dot');
    steps.forEach((s, i) => s.classList.toggle('active', i === this._onboardStep));
    dots.forEach((d, i) => d.classList.toggle('active', i === this._onboardStep));
    this.els.onboardNext.textContent = this._onboardStep === steps.length - 1 ? 'Get started' : 'Next';
  }

  _onboardNext() {
    const steps = this.els.onboardOverlay.querySelectorAll('.onboard-step');
    this._onboardStep++;
    if (this._onboardStep >= steps.length) {
      localStorage.setItem('earpiece.onboarded', '1');
      this.els.onboardOverlay.classList.remove('visible');
      return;
    }
    this._renderOnboard();
    this._haptic(8);
  }

  _esc(text) {
    const d = document.createElement('div');
    d.textContent = text ?? '';
    return d.innerHTML;
  }
}

window.__earpiece = new App();
