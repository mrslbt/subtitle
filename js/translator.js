export class Translator {
  constructor(opts = {}) {
    // For dev: use free MyMemory API (no key needed)
    // For prod: use Cloudflare Worker → DeepL
    this.workerUrl = opts.workerUrl || null;
    this.from = opts.from || 'ja';
    this.to = opts.to || 'en';
  }

  async translate(text) {
    if (!text || !text.trim()) return '';

    // If a worker URL is configured, use it (production mode)
    if (this.workerUrl) {
      return this._translateViaWorker(text);
    }

    // Dev mode: use MyMemory free API
    return this._translateMyMemory(text);
  }

  async _translateMyMemory(text) {
    const pair = `${this.from}|${this.to}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${pair}`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data.responseData && data.responseData.translatedText) {
        const translated = data.responseData.translatedText;
        // MyMemory sometimes returns all-caps for short phrases
        if (translated === translated.toUpperCase() && translated.length < 50) {
          return translated.charAt(0) + translated.slice(1).toLowerCase();
        }
        return translated;
      }
      throw new Error('No translation in response');
    } catch (err) {
      console.error('Translation error:', err);
      return `[translation failed: ${text}]`;
    }
  }

  async _translateViaWorker(text) {
    try {
      const res = await fetch(this.workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          source_lang: this.from.toUpperCase(),
          target_lang: this.to.toUpperCase(),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.translation || data.text || '';
    } catch (err) {
      console.error('Worker translation error:', err);
      // Fallback to MyMemory
      return this._translateMyMemory(text);
    }
  }
}
