# Subtitle / Japan

Live bilingual subtitles for in-person conversations. Runs in a browser, uses your own OpenAI key, JP↔EN.

Built for the person who lives in Tokyo and needs to follow a meeting where half the room speaks Japanese and the other half doesn't. Press a button. Speak. Read.

```
┌──────────────────────────────┬──────────────────────────────┐
│  A · CHANNEL · ENGLISH       │  B · CHANNEL · 日本語         │
│                              │                              │
│  History entries scroll up   │  ─────────                   │
│  ─────────                   │  履歴がここに溜まる          │
│  ▸ NOW                       │  ▸ NOW                       │
│  The meeting starts at 3pm.  │  今日の会議は三時からです。  │
└──────────────────────────────┴──────────────────────────────┘
```

Both channels populate on every utterance. The Japanese speaker reads CH B; the English speaker reads CH A. When you stop, the conversation downloads as a markdown transcript.

---

## What it actually is

A web app that opens two parallel `gpt-realtime-translate` WebSocket sessions, fans the microphone audio to both, and renders the streamed transcripts as broadcast-style subtitles on a black background. Sentences split on punctuation (`。！？` for JP, `.!?` followed by space for EN) and on 2.5s of silence.

No SaaS lock-in. No hardware. No data ever leaves your laptop except the audio that goes straight to OpenAI on your own API key.

---

## Requirements

- macOS, Linux, or Windows with Python 3.10+
- An [OpenAI API key](https://platform.openai.com/api-keys) with access to `gpt-realtime-translate`
- A modern browser (Chrome/Safari/Firefox — needs `AudioWorklet` + `WebSocket`)
- Microphone

Cost: about **$0.07 per minute of audio** (two parallel sessions at $0.034/min each, since both run for bidirectional coverage). A 30-minute meeting costs roughly $2.

---

## Setup (one-time)

```bash
git clone https://github.com/YOUR/subtitle.git
cd subtitle

# Install deps in a venv
python3 -m venv .venv
source .venv/bin/activate
pip install -r server/requirements.txt
```

---

## Run

```bash
export OPENAI_API_KEY="sk-..."   # your key
python3 server/server.py
```

Then open **http://localhost:8787/live** in your browser. Press the round button. Allow the mic. Speak in either language.

When you're done, press the button again to stop, then click **EXPORT · MD** to download the conversation.

---

## What's where

```
subtitle/
├── live.html                    # the main page — open at /live
├── js/
│   ├── pcm-worklet.js           # AudioWorklet: mic → 24kHz PCM16 frames
│   └── ... (legacy files from the prototype era — safe to ignore)
├── server/
│   ├── server.py                # FastAPI + WebSocket proxy to OpenAI
│   ├── requirements.txt
│   └── start.sh
└── README.md
```

The interesting pieces:

| File | What it does |
|---|---|
| `live.html` | The whole UI — broadcast-style two-column subtitle viewer with sentence splitting and a Markdown exporter |
| `js/pcm-worklet.js` | AudioWorklet that runs in a high-priority audio thread, downsamples mic input from 48kHz → 24kHz, converts Float32 → PCM16, posts frames to the main thread |
| `server/server.py` | FastAPI server. Hosts `/live`, serves the static JS, and exposes `/realtime` — a WebSocket that proxies to two parallel `gpt-realtime-translate` upstream sessions (one for EN output, one for JP output), routing events by language to the right panel |

---

## How the routing actually works

OpenAI's `gpt-realtime-translate` takes audio in and streams one *output* language out. To get both directions you open two sessions and fan the audio to both.

Each session emits two streams: `input_audio_transcription` (the source language) and `audio_transcript` (the translation). The server tags every event with which **panel** it belongs to — based on the language of the text, not which session produced it:

- EN-output session → its translation goes to LEFT (English panel); its input transcription goes to RIGHT (Japanese panel)
- JP-output session → its translation goes to RIGHT (Japanese panel); its input transcription goes to LEFT (English panel)

The result: both panels populate on every utterance regardless of who's speaking.

---

## Roadmap

- **v0.1 — now** — web app, single user, BYOK
- **v0.2** — Korean and Mandarin channel variants
- **v0.3** — PWA installable to iPhone home screen, persistent history
- **v0.4** — iOS Live Activity (lock-screen subtitles), Apple Watch glance
- **v1.0** — Vision Pro spatial captions, AR glasses targets (Even G2, RayNeo X3)

The current web app is the lowest-friction beta of the future AR app. Same product, smaller form factor.

---

## License

MIT. Use it, fork it, ship variants for your language pair.

---

## Acknowledgments

- [OpenAI gpt-realtime-translate](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide) — the translation engine that made the latency feasible
- The broadcast-subtitle conventions of NHK BS, the FIDS boards at Narita, and the anime fansub yellow that nobody can quite get out of their head

Built by [Marsel Bait](https://github.com/marselbait) in Tokyo.
