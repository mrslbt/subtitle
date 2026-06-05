"""
earpiece translation server — runs on Mac mini (Apple Silicon)

Pipeline:
  audio chunk (webm/wav) → mlx-whisper (Japanese STT) → DeepL (translation) → JSON response

Environment:
  DEEPL_API_KEY   (optional — falls back to free MyMemory API if not set)
  WHISPER_MODEL   (default: "mlx-community/whisper-large-v3-mlx")
  PORT            (default: 8787)
"""

import asyncio
import os
import tempfile
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import httpx
import websockets
import json as _json
import re
from datetime import datetime, timezone
from threading import Lock

# Optional deps — the realtime/live path doesn't need either, so we
# tolerate them being absent (lets the server boot on a vanilla Python
# install with just fastapi+websockets). The /transcribe path will 503
# if mlx_whisper isn't there; the romaji helper returns empty if
# pykakasi isn't there.
try:
    import mlx_whisper
except Exception as _e:
    mlx_whisper = None
    print(f"[earpiece] mlx_whisper not available: {_e} — /transcribe + /translate will 503")

try:
    import pykakasi
except Exception as _e:
    pykakasi = None
    print(f"[earpiece] pykakasi not available — romaji disabled")


# ─── Config ───
MODEL = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-large-v3-mlx")

# Client can override per-request via ?model=accuracy|speed
MODEL_OPTIONS = {
    "accuracy": "mlx-community/whisper-large-v3-mlx",
    "speed": "kaiinui/kotoba-whisper-v2.0-mlx",
}

def _pick_model(param: str | None) -> str:
    """Resolve per-request model hint. Falls back to MODEL env var if unknown."""
    if param and param in MODEL_OPTIONS:
        return MODEL_OPTIONS[param]
    return MODEL
DEEPL_KEY = os.environ.get("DEEPL_API_KEY", "").strip()
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
PORT = int(os.environ.get("PORT", 8787))

# OpenAI Realtime Translate config — see /realtime WebSocket endpoint below.
# This model (released May 2026) takes audio in, streams English text out,
# pace-matches the speaker, and natively handles Japanese SOV verb-position.
# It replaces the Ollama-based /translate_stream path for live meetings.
OPENAI_REALTIME_URL = (
    "wss://api.openai.com/v1/realtime/translations"
    "?model=gpt-realtime-translate"
)
OPENAI_REALTIME_LANGUAGE = "en"  # output language

# Path for persistent personal glossary (proper nouns, names, places)
GLOSSARY_PATH = Path(os.environ.get("GLOSSARY_PATH", Path.home() / ".earpiece" / "glossary.json"))
GLOSSARY_PATH.parent.mkdir(parents=True, exist_ok=True)

# Translator backend priority: ollama > deepl > mymemory
# Set TRANSLATOR to force one: "ollama", "deepl", "mymemory"
TRANSLATOR = os.environ.get("TRANSLATOR", "auto").lower()
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:1.5b")

# ─── Whisper concurrency ───
# mlx_whisper.transcribe is a synchronous, CPU+NeuralEngine-heavy call. If we
# invoke it directly inside an `async def` route it blocks the entire event
# loop — which means while a partial-transcribe runs, no other request (like
# /translate_stream) can be served. So we:
#   1. run Whisper in a dedicated thread-pool executor (frees the event loop)
#   2. gate it behind a semaphore of size 1 (MLX isn't reentrant-safe and
#      parallel calls would just thrash the neural engine anyway)
_whisper_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")
_whisper_gate = asyncio.Semaphore(1)

async def _run_whisper(audio, **kwargs):
    if mlx_whisper is None:
        raise HTTPException(status_code=503, detail="mlx_whisper not installed on this server")
    # Anti-hallucination defaults. Whisper has a known failure mode where it
    # produces plausible-sounding filler or textbook repetition loops
    # ("私は、私の家で作ったお菓子を作ります" x12) when the audio is low-
    # signal — silence with a hum, keyboard clatter, distant voices. These
    # knobs make it more eager to admit "that's silence" than to invent.
    #   - condition_on_previous_text=False: breaks the self-feeding loop
    #     where Whisper uses its own hallucinated output as the prompt for
    #     the next segment, causing the characteristic multi-sentence
    #     repetitions.
    #   - compression_ratio_threshold=1.8 (default 2.4): lower = stricter.
    #     Looped text compresses aggressively; this triggers temperature
    #     fallback (retry with higher temp) and ultimately rejection.
    #   - logprob_threshold=-0.7 (default -1.0): raises the confidence bar.
    #   - no_speech_threshold=0.5 (default 0.6): lower = more eager to
    #     classify a segment as silence instead of transcribing noise.
    # Callers can override any of these via kwargs.
    kwargs.setdefault("condition_on_previous_text", False)
    kwargs.setdefault("compression_ratio_threshold", 1.8)
    kwargs.setdefault("logprob_threshold", -0.7)
    kwargs.setdefault("no_speech_threshold", 0.5)
    async with _whisper_gate:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            _whisper_executor,
            lambda: mlx_whisper.transcribe(audio, **kwargs),
        )


def _is_whisper_hallucination(text: str) -> bool:
    """Heuristic post-filter catching Whisper's two common failure modes:
    1. Multi-sentence repetition loops (same clause repeated 3+ times)
    2. Near-duplicate sentences (the "この動画は…この映像は…" pattern where
       Whisper produces the same claim twice with tiny variation)
    3. Extreme gzip-compressibility (highly repetitive strings compress
       to <20% of original)
    Returns True if the text looks hallucinated and should be discarded."""
    if not text:
        return False
    stripped = text.strip()
    if len(stripped) < 30:
        return False  # too short to reliably detect; let it through

    # (1) Clause-level repetition. Split on JP sentence delimiters.
    parts = [p.strip() for p in re.split(r'[。、！？!?]', stripped) if p.strip()]
    meaningful = [p for p in parts if len(p) >= 5]
    if len(meaningful) >= 3:
        # If more than half the clauses are duplicates of another, it's a loop.
        from collections import Counter
        counts = Counter(meaningful)
        max_count = counts.most_common(1)[0][1]
        if max_count >= 3 or max_count >= len(meaningful) * 0.5:
            return True

    # (2) Substring repetition: any ≥10-char chunk appearing 2+ times means
    # the utterance is largely duplicated. Catches "東京都の駅での放送です"
    # showing up twice in a single return.
    if len(stripped) >= 40:
        for i in range(0, len(stripped) - 12, 4):  # step 4 keeps it cheap
            chunk = stripped[i:i+12]
            if stripped.count(chunk) >= 2:
                return True

    # (3) Compression-ratio backstop for anything that slipped through.
    raw = stripped.encode('utf-8')
    if len(raw) >= 100:
        import gzip
        ratio = len(gzip.compress(raw)) / len(raw)
        if ratio < 0.22:
            return True

    return False


# ─── App ───
app = FastAPI(title="earpiece server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


# ═══ Personal Glossary ════════════════════════════════════════════
# Tracks proper nouns (names, places, etc) auto-detected from the user's
# conversations. The glossary is fed back to Whisper as initial_prompt so
# it biases transcription toward these exact terms — making it smarter
# the longer you use the app.
# ════════════════════════════════════════════════════════════════

_glossary_lock = Lock()
_glossary: dict[str, dict] = {}

# ─── STATELESS MODE ───
# The glossary system (auto-ingested proper nouns → Whisper initial_prompt +
# Ollama prompt injection) was biasing transcription and translation with
# stale context from previous sessions — a news term seen yesterday would
# hallucinate itself into today's meeting audio. The user wants pure
# translate-as-is with zero memory.
#
# Below the glossary is hard-disabled: load is skipped, ingest is a no-op,
# prompts return empty. The endpoints remain (return empty data) so the
# settings UI doesn't 404. To re-enable, flip STATELESS back to False and
# the original behavior returns.
STATELESS = True

def _glossary_load():
    global _glossary
    if STATELESS:
        _glossary = {}
        return
    try:
        if GLOSSARY_PATH.exists():
            with open(GLOSSARY_PATH, 'r') as f:
                _glossary = _json.load(f)
    except Exception as e:
        print(f"[glossary] load failed: {e}")
        _glossary = {}

def _glossary_save():
    if STATELESS:
        return
    try:
        with open(GLOSSARY_PATH, 'w') as f:
            _json.dump(_glossary, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[glossary] save failed: {e}")

_glossary_load()


# Patterns for proper-noun detection in Japanese.
# Priority: names with honorifics > long katakana sequences > kanji sequences near location markers
_PATTERNS = [
    # Names with honorifics: 田中さん、山田先生、佐藤様
    re.compile(r'([\u4E00-\u9FAF\u30A0-\u30FF]{1,6})(さん|ちゃん|くん|君|先生|様|殿|氏)'),
    # Locations near markers: 渋谷駅、新宿区、東京都
    re.compile(r'([\u4E00-\u9FAF]{2,6})(駅|区|市|町|村|県|府|都|通り|商店街|ビル)'),
    # Long katakana sequences (likely foreign names or brands)
    re.compile(r'([\u30A0-\u30FF]{3,15})'),
]

_STOP_WORDS = {
    # Common katakana that isn't a proper noun
    'コーヒー', 'ラーメン', 'ビール', 'テレビ', 'レストラン', 'メニュー', 'カード',
    'ホテル', 'タクシー', 'スマホ', 'パソコン', 'インターネット', 'ニュース',
    'ランチ', 'ディナー', 'サラダ', 'アルコール', 'ショッピング', 'トイレ',
    'エレベーター', 'エスカレーター', 'プレゼント', 'パーティー', 'コンビニ',
    'スーパー', 'デパート', 'マーケット',
}

def _extract_proper_nouns(jp_text: str) -> list[str]:
    """Extract likely proper nouns from Japanese text."""
    if not jp_text:
        return []
    found = []
    for pattern in _PATTERNS:
        for m in pattern.finditer(jp_text):
            term = m.group(1) if m.lastindex else m.group(0)
            term = term.strip()
            if not term or len(term) < 2:
                continue
            if term in _STOP_WORDS:
                continue
            found.append(term)
    # Dedupe while preserving order
    seen = set()
    return [t for t in found if not (t in seen or seen.add(t))]


def _glossary_ingest(jp_text: str):
    """Auto-add detected proper nouns to glossary."""
    if STATELESS:
        return
    terms = _extract_proper_nouns(jp_text)
    if not terms:
        return
    now = datetime.now(timezone.utc).isoformat()
    with _glossary_lock:
        changed = False
        for term in terms:
            if term in _glossary:
                _glossary[term]['last_seen'] = now
                _glossary[term]['count'] = _glossary[term].get('count', 0) + 1
            else:
                _glossary[term] = {'first_seen': now, 'last_seen': now, 'count': 1}
                changed = True
        if changed:
            _glossary_save()


def _glossary_prompt(limit: int = 30) -> str:
    """Return a sentence-shaped Whisper hotword prompt.
    Whisper's initial_prompt biases transcription toward terms mentioned.
    Returns a natural-sounding JP sentence listing recent terms."""
    if STATELESS:
        return ""
    with _glossary_lock:
        if not _glossary:
            return ""
        # Sort by most-recent last_seen, cap at limit
        items = sorted(
            _glossary.items(),
            key=lambda kv: kv[1].get('last_seen', ''),
            reverse=True,
        )[:limit]
        terms = [t for t, _ in items]
    if not terms:
        return ""
    # Format as a natural sentence so Whisper treats it as context
    return "この会話には次の固有名詞が含まれます：" + "、".join(terms) + "。"


# ─── Romaji converter (accurate, fast, offline) ───
_kakasi = pykakasi.kakasi() if pykakasi else None

def to_romaji(text: str) -> str:
    """Convert Japanese text to romaji (Hepburn). No-op if pykakasi absent."""
    if not text or _kakasi is None:
        return ""
    try:
        result = _kakasi.convert(text)
        return " ".join(item["hepburn"] for item in result if item.get("hepburn")).strip()
    except Exception:
        return ""


# ─── Translation helpers ───

_SYSTEM_PROMPT = """You are a skilled Japanese-to-English translator helping someone who lives in Tokyo understand spoken Japanese in real time.

Translate naturally the way a fluent bilingual native speaker would — capturing MEANING, not words. Match the register (casual/polite/keigo). Use the conversation context to resolve pronouns, topics, and implied subjects.

Output ONLY the English translation. No commentary. No Japanese. No quotes around the translation. Just the English, as if you were whispering it in the listener's ear."""


def _build_generate_prompt(text: str, context: list[dict] | None = None) -> str:
    """Completion-style prompt. Qwen2.5 follows /api/generate reliably for translation;
    /api/chat confuses it into rephrasing in Japanese instead of translating.

    STATELESS: we intentionally ignore `context` and do not inject glossary hints.
    Past sessions bleeding into present translations (e.g. a news term from yesterday
    hallucinating into today's meeting) was more harmful than helpful. The `context`
    param is kept in the signature because callers still pass it — we just drop it."""
    parts = [
        "Translate Japanese to natural, fluent English. Capture the meaning and register (casual/polite/keigo).",
        "Output ONLY the English translation. No preamble. No Japanese. No commentary. No quotes.",
        "",
        f"Japanese: {text}",
        "English:",
    ]
    return "\n".join(parts)


# Conversational preambles qwen2.5:1.5b sometimes emits despite the
# "No preamble" instruction. Two failure modes:
#
#  (a) Preamble + colon + actual translation:
#        "Let me translate this for you: The meeting is at 3 PM."
#      → strip the preamble, keep the sentence.
#
#  (b) Preamble ONLY — the model writes the preamble then hits the \n\n
#      stop sequence before emitting a translation:
#        "Sure! Here's your translation"
#      → there's nothing to keep; return empty so the UI shows no EN.
#
# _PREAMBLE_RE matches (a). _PREAMBLE_ONLY_RE matches (b) against the whole
# string, so we can detect "the model never wrote a translation" and return
# "" rather than letting the preamble leak to the screen.

_PREAMBLE_RE = re.compile(
    r'^(?:'
    r'(?:sure|okay|ok|of\s+course|certainly|alright|yes)[,!.\s]*'
    r')?'
    r'(?:'
    r'(?:here(?:\'s|\s+is|\s+you\s+go)|let\s+me|i(?:\'ll|\s+will|\s+can|\s+shall))'
    r'[^\n:.]{0,80}?'
    r'(?:translat|english|meaning|put\s+it|say\s+that|render|convert)'
    r'[^\n:.]{0,40}?'
    r'[:.]\s*'
    r'|'
    r'(?:the\s+)?(?:english\s+translation|translation)\s+(?:is|would\s+be|in\s+english\s+is)'
    r'[^\n:.]{0,40}?'
    r'[:.]\s*'
    r')',
    re.IGNORECASE,
)

# Matches when the ENTIRE response is conversational preamble with no actual
# translation content — e.g. "Sure! Here's your translation" (no colon, no
# sentence after). Terminator is optional-colon + end-of-string.
_PREAMBLE_ONLY_RE = re.compile(
    r'^\s*'
    r'(?:(?:sure|okay|ok|of\s+course|certainly|alright|yes)[,!.\s]*)?'
    r'(?:'
    r'(?:here(?:\'s|\s+is|\s+you\s+go))\s+(?:your\s+|the\s+)?(?:english\s+)?translation'
    r'|'
    r'(?:let\s+me|i(?:\'ll|\s+will|\s+can|\s+shall))\s+translate\s+(?:this|that|it)(?:\s+for\s+you)?'
    r'|'
    r'(?:the\s+)?(?:english\s+)?translation(?:\s+is|\s+would\s+be)?'
    r')'
    r'\s*[:.!?]*\s*$',  # optional terminal punct, then end of string
    re.IGNORECASE,
)


def _strip_translation(content: str) -> str:
    content = content.strip()
    # (b) If the whole response is preamble and nothing else, return empty.
    # This happens when the model emits "Sure! Here's your translation" and
    # then hits the \n\n stop before writing the actual sentence.
    if _PREAMBLE_ONLY_RE.match(content):
        return ""
    # (a) Strip a leading preamble that IS followed by a real translation.
    # Up to two passes in case the model chains them ("Sure! Let me translate
    # this:").
    for _ in range(2):
        m = _PREAMBLE_RE.match(content)
        if not m:
            break
        content = content[m.end():].strip()
    # Check again after stripping — sometimes strip(a) leaves just a bare
    # preamble-like fragment.
    if _PREAMBLE_ONLY_RE.match(content):
        return ""
    # Then the simple known-prefix stripping for the completion-style labels.
    for prefix in ("Translation:", "English:", "Translated:", "Answer:"):
        if content.lower().startswith(prefix.lower()):
            content = content[len(prefix):].strip()
    # Stop at next Japanese: marker in case model continued
    if "\nJapanese:" in content:
        content = content.split("\nJapanese:")[0].strip()
    if content.startswith('"') and content.endswith('"'):
        content = content[1:-1]
    return content


async def translate_ollama(text: str, context: list[dict] | None = None) -> str:
    """Use local Ollama LLM via /api/generate for reliable translation."""
    prompt = _build_generate_prompt(text, context)
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
                "keep_alive": "24h",
                "options": {
                    "temperature": 0.2,
                    # Capped to prevent the 1.5B model from running away on
                    # ambiguous/filler-heavy input. An English translation of
                    # even a long JP utterance rarely exceeds 150 tokens.
                    "num_predict": 200,
                    "stop": ["\nJapanese:", "\n\n"],
                },
            },
        )
        r.raise_for_status()
        data = r.json()
        return _strip_translation(data.get("response", ""))


async def translate_deepl(text: str) -> str:
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            "https://api-free.deepl.com/v2/translate",
            headers={"Authorization": f"DeepL-Auth-Key {DEEPL_KEY}"},
            data={"text": text, "source_lang": "JA", "target_lang": "EN"},
        )
        r.raise_for_status()
        return r.json()["translations"][0]["text"]


async def translate_mymemory(text: str) -> str:
    """Free fallback — no API key needed."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            "https://api.mymemory.translated.net/get",
            params={"q": text, "langpair": "ja|en"},
        )
        r.raise_for_status()
        data = r.json()
        return data.get("responseData", {}).get("translatedText", "")


async def _ollama_available() -> bool:
    """Check if Ollama is reachable and has the model."""
    try:
        async with httpx.AsyncClient(timeout=2) as client:
            r = await client.get(f"{OLLAMA_URL}/api/tags")
            if r.status_code != 200:
                return False
            tags = r.json().get("models", [])
            return any(m.get("name", "").startswith(OLLAMA_MODEL.split(":")[0]) for m in tags)
    except Exception:
        return False


async def _prewarm_ollama():
    """Load Ollama model into memory at server startup so first request is fast."""
    try:
        print(f"[earpiece] pre-warming {OLLAMA_MODEL}...")
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                f"{OLLAMA_URL}/api/generate",
                json={
                    "model": OLLAMA_MODEL,
                    "prompt": "hi",
                    "stream": False,
                    "keep_alive": "24h",
                    "options": {"num_predict": 1},
                },
            )
            if r.status_code == 200:
                print(f"[earpiece] ollama warm ✓")
            else:
                print(f"[earpiece] pre-warm failed: HTTP {r.status_code}")
    except Exception as e:
        print(f"[earpiece] pre-warm error: {e}")


@app.on_event("startup")
async def startup():
    if await _ollama_available():
        # Fire and forget — don't block server startup
        import asyncio
        asyncio.create_task(_prewarm_ollama())


async def translate(text: str, context: list[dict] | None = None) -> tuple[str, str]:
    """Translate text with optional conversation context.

    Returns (translation, backend_used).
    """
    if not text.strip():
        return "", "none"

    # Choose backend
    order = []
    if TRANSLATOR == "ollama":
        order = ["ollama"]
    elif TRANSLATOR == "deepl":
        order = ["deepl", "mymemory"]
    elif TRANSLATOR == "mymemory":
        order = ["mymemory"]
    else:
        # auto: ollama if available → deepl if key → mymemory
        if await _ollama_available():
            order = ["ollama", "deepl", "mymemory"]
        elif DEEPL_KEY:
            order = ["deepl", "mymemory"]
        else:
            order = ["mymemory"]

    for backend in order:
        try:
            if backend == "ollama":
                return await translate_ollama(text, context), "ollama"
            if backend == "deepl" and DEEPL_KEY:
                return await translate_deepl(text), "deepl"
            if backend == "mymemory":
                return await translate_mymemory(text), "mymemory"
        except Exception as e:
            print(f"[{backend} failed] {e}")
            continue

    return "[translation failed]", "error"


# ─── Routes ───
@app.get("/health")
async def health():
    ollama_ok = await _ollama_available()
    if TRANSLATOR == "auto":
        active = "ollama" if ollama_ok else ("deepl" if DEEPL_KEY else "mymemory")
    else:
        active = TRANSLATOR
    with _glossary_lock:
        g_count = len(_glossary)
    return {
        "status": "ok",
        "model": MODEL,
        "translator": active,
        "ollama_available": ollama_ok,
        "ollama_model": OLLAMA_MODEL,
        "glossary_terms": g_count,
        "realtime_available": bool(OPENAI_API_KEY),
        "realtime_model": "gpt-realtime-translate" if OPENAI_API_KEY else None,
    }


import json


@app.post("/translate")
async def translate_audio(
    audio: UploadFile = File(...),
    context: str = None,
):
    # Parse context (JSON array of {jp, en} recent exchanges)
    ctx = []
    if context:
        try:
            ctx = json.loads(context)
            if not isinstance(ctx, list):
                ctx = []
        except Exception:
            ctx = []

    # Save audio to temp file
    suffix = Path(audio.filename or "audio.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        tmp_path = tmp.name

    try:
        # This endpoint is treated as a final-authoritative pass (not used for partials)
        prompt = _glossary_prompt()
        result = await _run_whisper(
            tmp_path,
            path_or_hf_repo=MODEL,
            language="ja",
            task="transcribe",
            initial_prompt=prompt if prompt else None,
        )
        jp_text = (result.get("text") or "").strip()

        if not jp_text:
            return {"japanese": "", "english": "", "empty": True}

        # Drop hallucinated loops / near-duplicate sentences before they
        # reach the translator and the user's screen.
        if _is_whisper_hallucination(jp_text):
            print(f"[whisper] dropped hallucination: {jp_text[:80]!r}")
            return {"japanese": "", "english": "", "empty": True, "dropped": "hallucination"}

        _glossary_ingest(jp_text)

        # Translate (with context if provided)
        en_text, backend = await translate(jp_text, ctx)

        return {
            "japanese": jp_text,
            "english": en_text,
            "empty": False,
            "backend": backend,
            "context_used": len(ctx),
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


@app.post("/translate_text")
async def translate_text(payload: dict):
    """Translate already-transcribed text. Useful for testing without audio."""
    text = (payload.get("text") or "").strip()
    context = payload.get("context") or []
    if not isinstance(context, list):
        context = []
    if not text:
        return {"english": ""}
    en, backend = await translate(text, context)
    return {"english": en, "backend": backend, "context_used": len(context)}


_COACHING_PROMPT = """You help a non-native speaker respond in Japanese conversation.

Given what someone said in Japanese, return EXACTLY 3 reply options with different tones.

Format: JSON object with "replies" array of 3 objects. Each object has:
- "jp": the Japanese reply (short, natural, casual-polite, 5-20 chars)
- "meaning": a short English translation of the JP reply (5-10 English words — REQUIRED, never empty)

The 3 replies should have different tones:
1. Enthusiastic or affirmative
2. Neutral / noncommittal / needs-more-info
3. Polite decline or counter-question

Example response shape:
{"replies": [
  {"jp": "ぜひ！", "meaning": "Definitely, let's do it!"},
  {"jp": "来週なら空いてます", "meaning": "Next week I'm free"},
  {"jp": "今週はちょっと忙しくて", "meaning": "This week I'm a bit busy"}
]}

Return ONLY the JSON object. No markdown, no commentary. Always fill both "jp" and "meaning". Always return exactly 3 items."""


async def suggest_replies_ollama(jp_text: str, context: list[dict] | None = None) -> list[dict]:
    messages = [{"role": "system", "content": _COACHING_PROMPT}]
    ctx_lines = []
    if context:
        for ex in context[-3:]:
            j = ex.get("jp", "").strip()
            e = ex.get("en", "").strip()
            if j and e:
                ctx_lines.append(f"- \"{j}\" ({e})")
    ctx_block = "\n\nRecent context:\n" + "\n".join(ctx_lines) if ctx_lines else ""
    user_msg = f"They said: \"{jp_text}\"{ctx_block}\n\nReturn 3 reply options as JSON."
    messages.append({"role": "user", "content": user_msg})

    async with httpx.AsyncClient(timeout=25) as client:
        r = await client.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": OLLAMA_MODEL,
                "messages": messages,
                "stream": False,
                "keep_alive": "24h",
                "options": {"temperature": 0.7, "num_predict": 500},
                "format": "json",
            },
        )
        r.raise_for_status()
        data = r.json()
        content = data.get("message", {}).get("content", "").strip()

    # Try multiple parse strategies
    try:
        parsed = _json.loads(content)
    except _json.JSONDecodeError:
        start = content.find("{")
        end = content.rfind("}")
        if start >= 0 and end > start:
            try: parsed = _json.loads(content[start:end+1])
            except Exception: return []
        else:
            start = content.find("[")
            end = content.rfind("]")
            if start >= 0 and end > start:
                try: parsed = _json.loads(content[start:end+1])
                except Exception: return []
            else:
                return []

    # Normalize to list of suggestions
    items = []
    if isinstance(parsed, list):
        items = parsed
    elif isinstance(parsed, dict):
        # Find the array inside
        for key in ("replies", "suggestions", "options", "answers"):
            if key in parsed and isinstance(parsed[key], list):
                items = parsed[key]
                break
        # Or: model returned a single suggestion as a flat object
        if not items and ("jp" in parsed or "japanese" in parsed):
            items = [parsed]

    out = []
    for item in items[:3]:
        if not isinstance(item, dict):
            continue
        jp = (item.get("jp") or item.get("japanese") or "").strip()
        meaning = (item.get("meaning") or item.get("en") or item.get("english") or "").strip()
        if jp:
            # Compute romaji ourselves — LLMs are unreliable at this
            out.append({"jp": jp, "romaji": to_romaji(jp), "meaning": meaning})
    return out


@app.post("/suggest_replies")
async def suggest_replies(payload: dict):
    """Given a Japanese question/statement, return 3 natural reply options."""
    text = (payload.get("text") or "").strip()
    context = payload.get("context") or []
    if not isinstance(context, list):
        context = []
    if not text:
        return {"suggestions": []}
    if not await _ollama_available():
        return {"suggestions": []}
    try:
        suggestions = await suggest_replies_ollama(text, context)
        return {"suggestions": suggestions}
    except Exception as e:
        return {"suggestions": [], "error": str(e)}


@app.post("/transcribe")
async def transcribe_only(
    audio: UploadFile = File(...),
    final: bool = False,
    model: str | None = None,
):
    """Whisper only — returns Japanese text fast, for parallel pipelines.

    - `final=true`: authoritative pass. Uses glossary as initial_prompt for
      proper-noun accuracy. Auto-ingests detected proper nouns into the glossary.
    - `final=false` (default): partial / mid-speech pass. NO initial_prompt
      (avoids hallucination on short audio). No glossary ingestion.
    - `model`: "accuracy" (large-v3, slower+better) or "speed" (kotoba, faster).
    """
    chosen_model = _pick_model(model)
    suffix = Path(audio.filename or "audio.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        tmp_path = tmp.name
    try:
        # Only bias transcription with the glossary on final passes.
        # Whisper hallucinates on short audio when given long prompts.
        prompt = _glossary_prompt() if final else None
        result = await _run_whisper(
            tmp_path,
            path_or_hf_repo=chosen_model,
            language="ja",
            task="transcribe",
            initial_prompt=prompt if prompt else None,
        )
        jp_text = (result.get("text") or "").strip()

        # Catch hallucinated loops on final passes. For partials we pass
        # through: partials are short, rarely loop, and the stream-update
        # path relies on growing text — dropping a partial abruptly hides
        # the speaking UI state.
        if final and jp_text and _is_whisper_hallucination(jp_text):
            print(f"[whisper] dropped hallucination (final): {jp_text[:80]!r}")
            return {"japanese": "", "empty": True, "model": chosen_model, "dropped": "hallucination"}

        if final and jp_text:
            _glossary_ingest(jp_text)

        return {"japanese": jp_text, "empty": not jp_text, "model": chosen_model}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


# ─── Glossary endpoints ───

@app.get("/glossary")
async def glossary_get():
    """Return the full glossary, sorted by most recent."""
    with _glossary_lock:
        items = [
            {"term": k, **v}
            for k, v in sorted(
                _glossary.items(),
                key=lambda kv: kv[1].get('last_seen', ''),
                reverse=True,
            )
        ]
    return {"items": items, "count": len(items)}


@app.post("/glossary/add")
async def glossary_add(payload: dict):
    """Manually add a term."""
    term = (payload.get("term") or "").strip()
    if not term:
        return {"ok": False, "error": "empty term"}
    now = datetime.now(timezone.utc).isoformat()
    with _glossary_lock:
        if term in _glossary:
            _glossary[term]['last_seen'] = now
        else:
            _glossary[term] = {'first_seen': now, 'last_seen': now, 'count': 1}
        _glossary_save()
    return {"ok": True, "term": term}


@app.post("/glossary/delete")
async def glossary_delete(payload: dict):
    term = (payload.get("term") or "").strip()
    with _glossary_lock:
        removed = _glossary.pop(term, None)
        if removed:
            _glossary_save()
    return {"ok": bool(removed)}


@app.post("/glossary/clear")
async def glossary_clear():
    with _glossary_lock:
        n = len(_glossary)
        _glossary.clear()
        _glossary_save()
    return {"ok": True, "cleared": n}


@app.post("/translate_stream")
async def translate_text_stream(payload: dict):
    """Stream translation tokens back as Server-Sent Events.

    Response format (SSE):
      data: {"delta": "Hel"}
      data: {"delta": "lo"}
      data: {"done": true}
    """
    text = (payload.get("text") or "").strip()
    context = payload.get("context") or []
    if not isinstance(context, list):
        context = []

    if not text:
        async def empty():
            yield f"data: {_json.dumps({'done': True})}\n\n"
        return StreamingResponse(empty(), media_type="text/event-stream")

    # Only ollama backend supports streaming; fall back to non-stream for others
    backend_available = await _ollama_available() if TRANSLATOR in ("auto", "ollama") else False
    if not backend_available:
        # Non-streaming fallback: do full translate, emit as single chunk
        async def fallback():
            en, _ = await translate(text, context)
            yield f"data: {_json.dumps({'delta': en})}\n\n"
            yield f"data: {_json.dumps({'done': True})}\n\n"
        return StreamingResponse(fallback(), media_type="text/event-stream")

    prompt = _build_generate_prompt(text, context)

    async def stream_tokens():
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_URL}/api/generate",
                    json={
                        "model": OLLAMA_MODEL,
                        "prompt": prompt,
                        "stream": True,
                        "keep_alive": "24h",
                        "options": {
                            "temperature": 0.2,
                            "num_predict": 200,
                            "stop": ["\nJapanese:", "\n\n"],
                        },
                    },
                ) as r:
                    buf = ""
                    emitted = ""
                    async for line in r.aiter_lines():
                        if not line:
                            continue
                        try:
                            data = _json.loads(line)
                        except Exception:
                            continue
                        content = data.get("response", "")
                        if content:
                            buf += content
                            # Clean the cumulative buffer and emit only the delta
                            cleaned = _strip_translation(buf)
                            if cleaned and len(cleaned) > len(emitted):
                                new_part = cleaned[len(emitted):]
                                emitted = cleaned
                                yield f"data: {_json.dumps({'delta': new_part})}\n\n"
                        if data.get("done"):
                            yield f"data: {_json.dumps({'done': True})}\n\n"
                            return
        except Exception as e:
            yield f"data: {_json.dumps({'error': str(e), 'done': True})}\n\n"

    return StreamingResponse(stream_tokens(), media_type="text/event-stream")


# ═══ OpenAI Realtime Translate proxy ═════════════════════════════
# Browser ↔ this server ↔ OpenAI Realtime API. We can't connect the
# browser directly because that would leak the API key. So we sit in
# the middle: accept PCM16 audio frames from the browser, forward them
# to OpenAI, stream the English transcript deltas back.
#
# Protocol (browser ↔ server):
#   browser → {type: "audio", data: "<base64-pcm16-24khz-mono>"}
#   browser → {type: "commit"}   — signal end-of-utterance, ask for flush
#   server  → {type: "ready"}    — upstream connected, you can send audio
#   server  → {type: "delta", text: "..."}
#   server  → {type: "done"}     — upstream finished a turn
#   server  → {type: "error", message: "..."}
#
# Audio format: 24 kHz mono PCM16, little-endian. The AudioWorklet in
# js/pcm-worklet.js handles capture + downsample + PCM16 conversion.
# ════════════════════════════════════════════════════════════════

# Map of OpenAI event type → our forwarding behavior. The translations
# endpoint (gpt-realtime-translate) emits session.* events for both
# input transcription and output translation. Verified June 2026 by
# direct probe — older docs referenced conversation.item.* and
# response.audio_transcript.* names from the standard realtime API
# but those do NOT fire on the translations endpoint.
_REALTIME_DELTA_EVENTS = {
    "session.output_transcript.delta": "delta",
    "session.input_transcript.delta": "input_delta",
}
_REALTIME_DONE_EVENTS = {
    "session.output_transcript.done",
}
_REALTIME_INPUT_DONE_EVENTS = {
    "session.input_transcript.done",
    "session.input_transcript.completed",
}


async def _open_translate_session(target_lang: str, api_key: str):
    """Open one upstream WebSocket to gpt-realtime-translate configured
    for a given output language using the provided api_key. Returns the
    connected websocket."""
    upstream = await websockets.connect(
        OPENAI_REALTIME_URL,
        additional_headers={"Authorization": f"Bearer {api_key}"},
        max_size=16 * 1024 * 1024,
    )
    await upstream.send(_json.dumps({
        "type": "session.update",
        "session": {
            "audio": {
                "input": {"transcription": {"model": "whisper-1"}},
                "output": {"language": target_lang},
            },
        },
    }))
    return upstream


@app.websocket("/realtime")
async def realtime_translate(ws: WebSocket):
    """Bidirectional translation proxy.

    Opens TWO upstream sessions to gpt-realtime-translate:
      • left  — output.language=en — fires when user speaks Japanese
      • right — output.language=ja — fires when user speaks English
    Both receive the same audio frames. The model only emits transcripts
    in its configured output language when the input is the *other*
    language, so each session naturally filters by direction.

    Client events:
      receive — {type: "ready"}
                {type: "delta",      side: "left"|"right", text: "..."}   (translation chunk)
                {type: "input_delta",side: "left"|"right", text: "..."}   (original-language chunk)
                {type: "input_done", side: "left"|"right", text: "..."}
                {type: "done",       side: "left"|"right"}
                {type: "error",      message: "..."}
      send    — {type: "audio", data: "<base64 24kHz PCM16>"}
    """
    await ws.accept()

    # BYOK: wait briefly for the first client message. If it's
    # {type:"auth", key:"sk-..."} we use that key; if it's anything else
    # or never arrives, we fall back to the server env key. The Worker
    # deployment ALWAYS sends auth (and won't have an env key); local
    # dev sends auth too but tolerates env fallback for quick testing.
    api_key = OPENAI_API_KEY
    try:
        first = await asyncio.wait_for(ws.receive_text(), timeout=10)
        try:
            first_msg = _json.loads(first)
        except Exception:
            first_msg = None
        if (
            isinstance(first_msg, dict)
            and first_msg.get("type") == "auth"
            and isinstance(first_msg.get("key"), str)
            and first_msg["key"].startswith("sk-")
        ):
            api_key = first_msg["key"]
    except (asyncio.TimeoutError, WebSocketDisconnect):
        pass

    if not api_key:
        await ws.send_text(_json.dumps({
            "type": "error",
            "message": "no OpenAI key (client must send {type:'auth', key:...})",
        }))
        await ws.close()
        return

    sessions = {}  # output_lang → upstream
    pump_tasks = []

    try:
        # Two upstream sessions, named by what they OUTPUT.
        #   en_up — output English (fires when JP is heard)
        #   ja_up — output Japanese (fires when EN is heard)
        en_up, ja_up = await asyncio.gather(
            _open_translate_session("en", api_key),
            _open_translate_session("ja", api_key),
        )
        sessions["en"] = en_up
        sessions["ja"] = ja_up

        await ws.send_text(_json.dumps({"type": "ready"}))

        # Each event has TWO language streams: the input transcription
        # (the language being spoken) and the output translation (the
        # other language). For Marsel's bidirectional UI we want each
        # PANEL to always show ONE language, regardless of which upstream
        # produced it:
        #   left panel  = English text   (en panel)
        #   right panel = Japanese text  (ja panel)
        #
        # Routing per upstream:
        #   en_up: delta (output, EN) → left.  input_delta (input, JP) → right.
        #   ja_up: delta (output, JP) → right. input_delta (input, EN) → left.
        #
        # This makes both panels populate on every utterance — each
        # speaker reads "their" side and always sees content in their
        # own language.
        PANEL_FOR = {
            ("en", "delta"):       "left",   # en_up's translation (English)
            ("en", "input_delta"): "right",  # en_up's input transcription (Japanese)
            ("ja", "delta"):       "right",  # ja_up's translation (Japanese)
            ("ja", "input_delta"): "left",   # ja_up's input transcription (English)
        }

        async def pump_upstream(out_lang: str, upstream):
            try:
                async for raw in upstream:
                    try:
                        evt = _json.loads(raw)
                    except Exception:
                        continue
                    etype = evt.get("type", "")

                    if etype in _REALTIME_DELTA_EVENTS:
                        kind = _REALTIME_DELTA_EVENTS[etype]  # "delta" | "input_delta"
                        panel = PANEL_FOR.get((out_lang, kind))
                        if not panel:
                            continue
                        delta = evt.get("delta") or evt.get("text") or ""
                        if delta:
                            await ws.send_text(_json.dumps({
                                "type": kind,
                                "panel": panel,
                                "session": out_lang,  # for utterance pairing in export
                                "text": delta,
                            }))
                    elif etype in _REALTIME_INPUT_DONE_EVENTS:
                        # Input transcription completed for this upstream
                        # → panel is the OPPOSITE language from out_lang
                        panel = "right" if out_lang == "en" else "left"
                        transcript = evt.get("transcript") or ""
                        await ws.send_text(_json.dumps({
                            "type": "input_done",
                            "panel": panel,
                            "session": out_lang,
                            "text": transcript,
                        }))
                    elif etype in _REALTIME_DONE_EVENTS:
                        # Output (translation) completed for this upstream
                        # → panel is the OUT language panel
                        panel = "left" if out_lang == "en" else "right"
                        await ws.send_text(_json.dumps({
                            "type": "done",
                            "panel": panel,
                            "session": out_lang,
                        }))
                    elif etype == "error" or etype.endswith(".error"):
                        msg = (evt.get("error") or {}).get("message") or evt.get("message") or "upstream error"
                        print(f"[realtime/{out_lang}] ERROR: {evt}")
                        await ws.send_text(_json.dumps({
                            "type": "error", "message": f"{out_lang}: {msg}",
                        }))
            except websockets.ConnectionClosed:
                pass
            except Exception as e:
                print(f"[realtime/{out_lang}] pump crashed: {e}")

        pump_tasks = [
            asyncio.create_task(pump_upstream("en", en_up)),
            asyncio.create_task(pump_upstream("ja", ja_up)),
        ]

        # Pump browser → both upstreams.
        while True:
            try:
                msg = await ws.receive_text()
            except WebSocketDisconnect:
                break
            try:
                data = _json.loads(msg)
            except Exception:
                continue

            mtype = data.get("type")
            if mtype == "audio":
                audio_b64 = data.get("data") or ""
                if not audio_b64:
                    continue
                payload = _json.dumps({
                    "type": "session.input_audio_buffer.append",
                    "audio": audio_b64,
                })
                # Fan out to both sessions in parallel.
                await asyncio.gather(
                    en_up.send(payload),
                    ja_up.send(payload),
                    return_exceptions=True,
                )
            elif mtype == "ping":
                await ws.send_text(_json.dumps({"type": "pong"}))

    except websockets.WebSocketException as e:
        print(f"[realtime] connect failed: {e}")
        try:
            await ws.send_text(_json.dumps({
                "type": "error",
                "message": f"upstream connect failed: {e}",
            }))
        except Exception:
            pass
    except Exception as e:
        print(f"[realtime] fatal: {e}")
        try:
            await ws.send_text(_json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass
    finally:
        for t in pump_tasks:
            if not t.done():
                t.cancel()
        for up in sessions.values():
            try:
                await up.close()
            except Exception:
                pass
        try:
            await ws.close()
        except Exception:
            pass


# ─── Serve the web app ───
# The web app lives one directory up (index.html, style.css, js/)
WEB_ROOT = Path(__file__).resolve().parent.parent

NO_CACHE = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}

# For CSS/JS served with ?v=<hash> query strings. The HTML (which is itself
# no-cache) injects a fresh hash whenever any tracked file's mtime changes,
# so the URL changes → browser re-fetches. Until then cache aggressively so
# repeat loads are instant instead of fetching ~100KB on every visit.
CACHE_LONG = {
    "Cache-Control": "public, max-age=31536000, immutable",
}

if (WEB_ROOT / "index.html").exists():
    import time, re
    from fastapi.responses import HTMLResponse, Response

    def _compute_version() -> str:
        # Hash of all file mtimes — changes when any file changes
        mtimes = []
        for p in [WEB_ROOT / "index.html", WEB_ROOT / "style.css"]:
            if p.exists(): mtimes.append(str(int(p.stat().st_mtime)))
        js_dir = WEB_ROOT / "js"
        if js_dir.exists():
            for p in sorted(js_dir.glob("*.js")):
                mtimes.append(str(int(p.stat().st_mtime)))
        return str(abs(hash("".join(mtimes))))[-8:]

    def _render_html(path: Path) -> HTMLResponse:
        html = path.read_text()
        v = _compute_version()
        html = re.sub(
            r'(href|src)="(style\.css|js/[^"]+)"',
            lambda m: f'{m.group(1)}="{m.group(2)}?v={v}"',
            html,
        )
        return HTMLResponse(html, headers=NO_CACHE)

    @app.get("/")
    async def index():
        return _render_html(WEB_ROOT / "index.html")

    # Legacy redirect — Marsel may have bookmarked /minimal
    @app.get("/minimal")
    async def minimal_redirect():
        from fastapi.responses import RedirectResponse
        return RedirectResponse("/", status_code=301)

    # Subtitle live page. Canonical source = worker/public/index.html (same
    # file shipped to Cloudflare). Falls back to a root-level live.html
    # if someone has the older layout. Returns 404 if neither exists.
    @app.get("/live")
    async def live_page():
        for path in (WEB_ROOT / "worker" / "public" / "index.html",
                     WEB_ROOT / "live.html"):
            if path.exists():
                return HTMLResponse(path.read_text(), headers=NO_CACHE)
        raise HTTPException(status_code=404, detail="live page not found")

    @app.get("/js/{name}")
    async def js_file(name: str):
        if ".." in name:
            raise HTTPException(status_code=404)
        # Canonical first (the Worker-bound public dir), then legacy js/.
        # pcm-worklet.js lives in worker/public/js/; the legacy convo/meeting
        # app's modules still live in /js at repo root.
        path = None
        for base in (WEB_ROOT / "worker" / "public" / "js", WEB_ROOT / "js"):
            candidate = base / name
            if candidate.exists():
                path = candidate
                break
        if path is None:
            raise HTTPException(status_code=404)
        content = path.read_text()
        v = _compute_version()
        # Rewrite ES module imports to include version
        content = re.sub(
            r"from\s+['\"](\.\/[^'\"]+)['\"]",
            lambda m: f"from '{m.group(1)}?v={v}'",
            content,
        )
        return Response(content, media_type="text/javascript", headers=CACHE_LONG)

    @app.get("/style.css")
    async def style():
        return FileResponse(WEB_ROOT / "style.css", media_type="text/css", headers=CACHE_LONG)


if __name__ == "__main__":
    import uvicorn

    print(f"[earpiece] starting on port {PORT}")
    print(f"[earpiece] whisper model: {MODEL}")
    print(f"[earpiece] translator: {'DeepL' if DEEPL_KEY else 'MyMemory (free)'}")
    print(f"[earpiece] web root: {WEB_ROOT}")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
