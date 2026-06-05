# subtitle

Live bilingual subtitles for in-person conversations. JP↔EN. Browser only, your own OpenAI key.

Two parallel `gpt-realtime-translate` sessions over WebSocket. Both panels populate on every utterance: the Japanese speaker reads CH B, the English speaker reads CH A. Press the button. Speak. Read. Stop. Download the conversation as Markdown.

```
┌──────────────────────────────┬──────────────────────────────┐
│ A · CHANNEL · ENGLISH        │ B · CHANNEL · 日本語          │
│                              │                              │
│ history scrolls up here      │ 履歴がここに溜まる            │
│ ─────────                    │ ─────────                    │
│ ▸ NOW                        │ ▸ NOW                        │
│ The meeting starts at 3pm.   │ 今日の会議は三時からです。   │
└──────────────────────────────┴──────────────────────────────┘
```

## Who this is for

- Expats in Tokyo following a meeting where half the room speaks Japanese
- Language learners past the beginner stage who want a reading layer on conversations
- Anyone who'd rather pay $0.07/min to OpenAI than $300 for a Pocketalk
- Future AR glasses users (web is the v0; the form factor changes, the product doesn't)

## Setup

Requires Python 3.10+, an [OpenAI API key](https://platform.openai.com/api-keys) with `gpt-realtime-translate` access, and a Chromium-based browser or Safari.

```bash
git clone https://github.com/mrslbt/subtitle.git
cd subtitle

python3 -m venv .venv
source .venv/bin/activate
pip install -r server/requirements.txt
```

## Run (local dev)

```bash
export OPENAI_API_KEY="sk-..."
python3 server/server.py
```

Open http://localhost:8787/live. The page renders with a `NO KEY` chip in the top right. Click it, paste your key in the settings card, save. Press the round button. Allow the mic. Speak either language.

The key is stored only in `localStorage`. The server falls back to the env key if the client doesn't send one, which makes local testing fast.

To stop, press the button again. The **EXPORT · MD** button appears next to the mic. Click it to download a timestamped Markdown transcript of the whole conversation.

## Deploy to Cloudflare (subtitles.bymarsel.me)

Subtitle runs as a single Cloudflare Worker — the page and the WebSocket proxy live in one place. No backend server to keep alive.

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

Then attach a custom domain:
- Cloudflare dashboard → **Workers & Pages** → `subtitle` → **Settings** → **Triggers** → **Custom Domains** → **Add Custom Domain** → `subtitles.bymarsel.me`

Done. The Worker uses **only** the API key each visitor pastes in settings. No server-side OpenAI key is stored or required. Users bring their own, costs land on their own OpenAI account.

## Cost

Two parallel `gpt-realtime-translate` sessions stay open while subtitling is on. OpenAI charges $0.034/min per session, so the real-world cost is roughly:

| Length | Cost |
|---|---|
| 30 min meeting | ~$2 |
| 1 hour | ~$4 |
| 8 hour all-day | ~$32 |

The two sessions run because the model is unidirectional per session (one input language pair). Running both gives every utterance an EN render and a JP render regardless of who spoke.

## What's where

```
subtitle/
├── worker/                 Cloudflare Worker — production deploy target
│   ├── wrangler.toml
│   ├── src/index.js        Worker code: WebSocket proxy with BYOK auth
│   └── public/             Static assets (served by Worker AND local Python)
│       ├── index.html      The page — broadcast-style subtitle UI
│       └── js/pcm-worklet.js
└── server/                 Optional FastAPI server for local dev
    ├── server.py           Same /realtime semantics as the Worker
    └── requirements.txt
```

| File | What it does |
|---|---|
| `worker/public/index.html` | Two-column broadcast-style subtitle UI. Sentence splitter (Japanese 。！？ unambiguous, English `.!?` + space lookahead to skip abbreviations). 2.5s silence fallback for utterances the model emits without terminal punctuation. Settings card for BYOK key entry. Markdown export. |
| `worker/public/js/pcm-worklet.js` | Runs inside `AudioWorkletGlobalScope`. Downsamples mic input from 48kHz to 24kHz with linear interpolation, converts Float32 to little-endian PCM16, posts frames to the main thread every 100ms. Zero-copy transferable ArrayBuffers. |
| `worker/src/index.js` | Cloudflare Worker. Routes `/realtime` to the WebSocket handler, everything else to the static assets binding. Waits for the client's `{type:"auth", key}` frame, opens two upstream WebSockets to `wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate` with that key, fans audio to both, routes events back by language. |
| `server/server.py` | FastAPI mirror of the Worker for local dev. Same `/realtime` protocol. Accepts the same BYOK auth message; falls back to `OPENAI_API_KEY` env var if the client doesn't send one. |

## How the bidirectional flow works

`gpt-realtime-translate` is unidirectional per session: you set one output language, and the model translates whatever input audio it hears into that language. To get both directions, you open two sessions.

Each session emits two streams:

- `input_audio_transcription` — the source language (what was actually said)
- `audio_transcript` — the translation (in the configured output language)

The server reads the upstream's event type and the upstream's role, then sends to the correct panel:

| Upstream | Event type | Goes to |
|---|---|---|
| EN-output | translation (`audio_transcript`) | LEFT (English) |
| EN-output | input transcription | RIGHT (Japanese) |
| JP-output | translation (`audio_transcript`) | RIGHT (Japanese) |
| JP-output | input transcription | LEFT (English) |

Result: every utterance fills both panels. The Japanese speaker reads CH B for their own confirmation. The English speaker reads CH A.

## Audio path

| Stage | Format | Where |
|---|---|---|
| Mic capture | Float32, 48kHz (or whatever `AudioContext` gives) | browser |
| Downsample | Float32, 24kHz mono, linear interpolation | AudioWorklet |
| Quantize | Int16 little-endian PCM | AudioWorklet |
| Frame size | 100ms = 2400 samples = 4800 bytes | AudioWorklet |
| Encode | base64 | main thread |
| Transport | JSON over WebSocket | client → server → OpenAI |
| Fan-out | identical frames to both upstreams | server |

## Privacy

Audio leaves your machine only to OpenAI, only on your own API key. The server doesn't log audio. There's no analytics, no telemetry, no account. The Markdown export is a download. It never round-trips through any server.

On the Cloudflare deploy, your key lives in your own browser's `localStorage`. It rides as the first WebSocket message on each new session, gets used to authenticate the upstream OpenAI connections, and is never written to any log or database. The Worker is stateless.

For local dev, the key can also live in your shell environment as `OPENAI_API_KEY`. The repo's `.gitignore` excludes `.env` and `server/.env` so a key can't get committed by accident.

## Roadmap

- **v0.1** — web app, single user, BYOK *(you are here)*
- **v0.2** — Korean and Mandarin channel variants. Same UI pattern, different language pairs
- **v0.3** — PWA installable to iPhone home screen. Persistent IndexedDB history across sessions
- **v0.4** — iOS Live Activity (lock-screen subtitles), Apple Watch glance
- **v1.0** — Vision Pro spatial captions, AR glasses targets (Even G2, RayNeo X3)

The web app is the lowest-friction beta of the future AR app. Same product, smaller form factor.

## License

MIT.

## Author

Built by [Marsel Bait](https://github.com/mrslbt) in Tokyo.
