/**
 * Subtitle — Cloudflare Worker (transcribe + translate split)
 *
 * Architecture:
 *   browser  ─── ws ─── Worker  ─── ws ─── gpt-4o-transcribe
 *                          │
 *                          └── chat/completions ── gpt-4o-mini (translate)
 *
 * One upstream WebSocket to OpenAI's transcription endpoint runs
 * continuously. Server-side VAD handles speech-boundary detection.
 * Streaming transcription deltas land on whichever panel matches the
 * detected language. When an utterance completes, a chat-completions
 * call fires in parallel, streaming the translation chunks back to
 * the opposite panel.
 *
 * Compared to the old dual-session approach:
 *   • ~10× cheaper ($0.006/min audio vs $0.068/min dual)
 *   • Less hallucination (transcription model doesn't randomly drift
 *     into multilingual training data on poor signal)
 *   • Bidirectional preserved (auto language detection routes by content)
 *   • Translation quality matches gpt-4o-mini chat (very good)
 *
 * Routes:
 *   GET  /realtime  — WebSocket upgrade. Client must send
 *                     {type:"auth", key:"sk-..."} as the first message.
 *   *               — falls through to static assets bound as env.ASSETS.
 *
 * Client event shape (unchanged from prior versions for compatibility):
 *   server → {type:"ready"}
 *   server → {type:"input_delta",  panel, text}   — live transcript chunk
 *   server → {type:"input_done",   panel, text}   — transcript final
 *   server → {type:"delta",        panel, text}   — translation chunk
 *   server → {type:"done",         panel}         — translation final
 *   server → {type:"error",        message}
 *   client → {type:"audio",        data}          — base64 24kHz PCM16
 */

const TRANSCRIPTION_URL =
  "https://api.openai.com/v1/realtime?intent=transcription";
const TRANSCRIBE_MODEL = "gpt-4o-transcribe";
// Translation now happens client-side (browser → OpenAI directly) to
// avoid the Cloudflare Workers 50-subrequest-per-invocation limit
// that was killing long sessions. See public/index.html.

// ─── Script detectors / filters ────────────────────────────────────
// Real-world: the model occasionally hallucinates multilingual training
// data when the audio signal degrades. We reject anything whose script
// doesn't belong on its panel.

// Hiragana OR katakana — unambiguously Japanese.
function isJapanese(text) {
  return /[぀-ゟ゠-ヿｦ-ﾟ]/.test(text);
}

const EN_FORBIDDEN_RE = new RegExp(
  "[" +
    "Ͱ-Ͽ" + // Greek
    "Ѐ-ӿ" + // Cyrillic
    "԰-֏" + // Armenian
    "֐-׿" + // Hebrew
    "؀-ۿ" + // Arabic
    "ݐ-ݿ" + // Arabic supplement
    "ऀ-ॿ" + // Devanagari
    "஀-௿" + // Tamil
    "฀-๿" + // Thai
    "　-鿿" + // CJK punct + kana + kanji
    "가-힯" + // Hangul syllables
    "＀-￯" + // half/fullwidth
    "]"
);
function isCleanEn(text) {
  return !EN_FORBIDDEN_RE.test(text);
}

const JP_FORBIDDEN_RE = new RegExp(
  "[" +
    "Ͱ-Ͽ" +
    "Ѐ-ӿ" +
    "԰-֏" +
    "֐-׿" +
    "؀-ۿ" +
    "ݐ-ݿ" +
    "ऀ-ॿ" +
    "஀-௿" +
    "฀-๿" +
    "가-힯" +
    "ᄀ-ᇿ" +
    "㄰-㆏" +
    "]"
);
function isCleanJp(text) {
  return !JP_FORBIDDEN_RE.test(text);
}

// Strip foreign-script characters from `text` for the given panel.
// LEFT (JP→EN) source line should be Japanese — strip non-JP non-Latin.
// RIGHT (EN→JP) source line should be English — strip non-Latin.
// Returns the cleaned string (may be empty if everything was foreign).
function scrubForeign(text, panel) {
  // Globalized version of the per-panel forbidden ranges
  const re = panel === "left"
    ? new RegExp(JP_FORBIDDEN_RE.source, "g")
    : new RegExp(EN_FORBIDDEN_RE.source, "g");
  return text.replace(re, "");
}

// ─── Worker entrypoint ──────────────────────────────────────────────
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === "/realtime") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      return handleRealtime(req, ctx);
    }

    if (!env.ASSETS) {
      return new Response("Not Found", { status: 404 });
    }

    // Force-disable HTML caching so updates land on iPads without
    // having to delete the home-screen icon.
    const res = await env.ASSETS.fetch(req);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/html")) {
      const headers = new Headers(res.headers);
      headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      headers.set("Pragma", "no-cache");
      headers.set("Expires", "0");
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    }
    return res;
  },
};

function handleRealtime(req, ctx) {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  ctx.waitUntil(runSession(server).catch((e) => console.error("session:", e)));
  return new Response(null, { status: 101, webSocket: client });
}

// ─── Per-session orchestration ─────────────────────────────────────
async function runSession(client) {
  let key;
  try {
    key = await waitForAuth(client);
  } catch {
    safeSend(client, { type: "error", message: "auth timeout" });
    safeClose(client, 1008, "auth timeout");
    return;
  }
  if (!key) {
    safeSend(client, { type: "error", message: "missing OpenAI key" });
    safeClose(client, 1008, "auth required");
    return;
  }

  let upstream;
  try {
    upstream = await openTranscriptionSession(key);
  } catch (e) {
    const msg = (e && e.message) || "upstream connect failed";
    safeSend(client, { type: "error", message: msg });
    safeClose(client, 1011, "upstream failed");
    return;
  }

  safeSend(client, { type: "ready" });
  pumpUpstream(upstream, client, key);

  client.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "audio" && msg.data) {
      try {
        upstream.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.data,
        }));
      } catch {}
    } else if (msg.type === "ping") {
      safeSend(client, { type: "pong" });
    }
  });

  const close = () => {
    safeClose(upstream);
    safeClose(client);
  };
  client.addEventListener("close", close);
  client.addEventListener("error", close);
}

// Wait for the first client message and resolve with the OpenAI key.
function waitForAuth(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("auth timeout")), 10000);
    const onMsg = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m && m.type === "auth") {
          clearTimeout(timer);
          client.removeEventListener("message", onMsg);
          if (typeof m.key === "string" && m.key.startsWith("sk-")) {
            resolve(m.key);
          } else {
            resolve(null);
          }
        }
      } catch {}
    };
    client.addEventListener("message", onMsg);
  });
}

async function openTranscriptionSession(key) {
  const res = await fetch(TRANSCRIPTION_URL, {
    headers: {
      "Upgrade": "websocket",
      "Connection": "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Authorization": `Bearer ${key}`,
    },
  });
  if (res.status !== 101 || !res.webSocket) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 300); } catch {}
    throw new Error(`upstream HTTP ${res.status} ${detail}`);
  }
  const ws = res.webSocket;
  ws.accept();
  // Transcription session config.
  //
  // VAD tuning (June 2026 — after Marsel reported "slow + doesn't catch
  // many" in real meetings):
  //   threshold 0.35 (was 0.5) — picks up quieter speakers and people
  //     who don't lean into the mic. Cost: more false-positive triggers
  //     on cough/paper, but those just produce empty/garbage transcripts.
  //   prefix_padding_ms 400 (was 300) — catches the start of words that
  //     were getting clipped.
  //   silence_duration_ms 500 (was 700) — commits utterances faster,
  //     ~200ms shaved off translation latency. Risk: chops sentences on
  //     long thinking pauses, but Marsel preferred fast over polished.
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: TRANSCRIBE_MODEL },
          turn_detection: {
            type: "server_vad",
            threshold: 0.35,
            prefix_padding_ms: 400,
            silence_duration_ms: 500,
          },
        },
      },
    },
  }));
  return ws;
}

// Forward transcription events from upstream → client, and trigger
// translation when each utterance completes.
//
// PANEL MODEL: each panel represents a DIRECTION of translation, not
// a language. LEFT = "JP was spoken, here's the EN" pair. RIGHT = "EN
// was spoken, here's the JP" pair.
//
// Direction detection has three priorities:
//   1. Hiragana/katakana present → LEFT (definitely Japanese)
//   2. Latin letters present → RIGHT (English)
//   3. Neither (bare digits, kanji-only, punctuation) → inherit from
//      previous utterance's direction. The VAD chops "午後三時" into
//      a separate "3" item; without sticky direction those leak.
function pickDirection(text, fallback) {
  if (/[぀-ゟ゠-ヿｦ-ﾟ]/.test(text)) return "left";   // hiragana/katakana
  if (/[A-Za-z]/.test(text)) return "right";          // Latin letters
  return fallback;
}

function pumpUpstream(upstream, client, key) {
  // Sticky panel for the in-flight utterance.
  let currentPanel = null;
  // Session-wide last detected direction. Defaults to LEFT (JP) since
  // Marsel's meetings are 95%+ Japanese.
  let lastDirection = "left";

  upstream.addEventListener("message", (ev) => {
    let evt;
    try { evt = JSON.parse(ev.data); } catch { return; }
    const t = evt.type || "";

    if (t === "conversation.item.input_audio_transcription.delta") {
      const text = evt.delta || "";
      if (!text) return;
      if (!currentPanel) {
        currentPanel = pickDirection(text, lastDirection);
      }
      // Strip foreign-script characters instead of dropping the whole
      // delta — a single bad char (the model occasionally emits one
      // Cyrillic / Arabic char mid-Japanese) used to nuke entire
      // chunks, making the live transcript look broken.
      const cleaned = scrubForeign(text, currentPanel);
      if (!cleaned) return;
      safeSend(client, { type: "input_delta", panel: currentPanel, text: cleaned });
      return;
    }

    if (t === "conversation.item.input_audio_transcription.completed") {
      const raw = (evt.transcript || "").trim();
      if (!raw) {
        currentPanel = null;
        return;
      }
      // Strip foreign-script characters from the final transcript before
      // deciding language. Previously, one Hangul char in an otherwise
      // perfect JP sentence would drop the ENTIRE utterance silently.
      const transcript = scrubForeign(raw, "left").trim();
      if (!transcript) {
        currentPanel = null;
        return;
      }
      // JP → EN only. Skip if no Japanese script present (English audio,
      // music, etc).
      if (!isJapanese(transcript)) {
        currentPanel = null;
        return;
      }
      const panel = "left";
      lastDirection = panel;
      safeSend(client, {
        type: "input_done",
        panel,
        text: transcript,
      });
      // Translation runs in the BROWSER (not here) — see public/index.html.
      currentPanel = null;
      return;
    }

    if (t === "error" || t.endsWith(".error")) {
      const msg =
        (evt.error && evt.error.message) || evt.message || "upstream error";
      console.error("[transcribe upstream]", msg);
      safeSend(client, { type: "error", message: msg });
      return;
    }
    // Lifecycle / VAD events: ignore.
  });

  upstream.addEventListener("close", () => {
    safeSend(client, {
      type: "error",
      message: "transcription upstream closed",
    });
  });
}

// ─── Tiny helpers ───────────────────────────────────────────────────
function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}
function safeClose(ws, code, reason) {
  try { ws.close(code, reason); } catch {}
}
