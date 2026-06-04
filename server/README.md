# earpiece server — Mac mini setup

Runs Whisper (via Apple's MLX framework) + DeepL on your Mac mini. The iPhone app sends audio chunks to this server and gets back `{ japanese, english }`.

Designed for M1/M2/M3/M4 Mac minis. On M4 with 16GB, `large-v3` runs at 2-5× real-time.

---

## Quick start (3 steps)

### 1. Install

Open Terminal on your Mac mini, then:

```bash
cd /path/to/earpiece/server
./start.sh
```

First run will:
- Create a Python virtual environment
- Install `mlx-whisper`, `fastapi`, etc.
- Download the Whisper model (~3GB for `large-v3`) on first transcribe
- Start the server on port `8787`

### 2. (Optional) Add a DeepL API key for better translations

```bash
cp .env.example .env
# edit .env and paste your DeepL free key
# get one at: https://www.deepl.com/pro-api (500k chars/month free)
```

Without a DeepL key, the server uses the free MyMemory API (works fine, slightly lower quality).

### 3. Test it

```bash
curl http://localhost:8787/health
# → {"status":"ok","model":"mlx-community/whisper-large-v3-mlx","translator":"deepl"}
```

---

## Model choice

Edit `.env` to change models:

| Model | Size | Speed on M4 | Accuracy |
|---|---|---|---|
| `mlx-community/whisper-large-v3-mlx` (default) | ~3GB | 2-5× real-time | ⭐⭐⭐⭐⭐ |
| `mlx-community/whisper-medium-mlx` | ~1.5GB | 5-8× real-time | ⭐⭐⭐⭐ |
| `mlx-community/whisper-small-mlx` | ~500MB | 10× real-time | ⭐⭐⭐ |

Start with `large-v3`. You have the hardware for it.

---

## Run as a launchd service (auto-start on boot)

Create `~/Library/LaunchAgents/com.earpiece.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.earpiece.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/FULL/PATH/TO/earpiece/server/start.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/earpiece.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/earpiece.err</string>
</dict>
</plist>
```

Then:

```bash
launchctl load ~/Library/LaunchAgents/com.earpiece.server.plist
```

---

## Access from outside your home network

If you want to use earpiece when you're not on your home Wi-Fi (e.g. at a konbini), expose the server via **Cloudflare Tunnel** — free, HTTPS, takes ~5 min.

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create earpiece
cloudflared tunnel route dns earpiece earpiece.yourdomain.com
cloudflared tunnel run earpiece
```

Then point the iPhone app at `https://earpiece.yourdomain.com` instead of your local IP.

Alternative: **Tailscale** (private VPN, also free) — install on Mac mini + iPhone, then use the Mac mini's Tailscale IP.

---

## API

### `POST /translate`

Form data: `audio` (webm, wav, mp3, m4a...)

Response:
```json
{
  "japanese": "ポイントカードはお持ちですか？",
  "english": "Do you have a points card?",
  "empty": false
}
```

### `POST /translate_text`

JSON body: `{ "text": "..." }` — for testing without audio.

### `GET /health`

Returns server status and config.
