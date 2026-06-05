/**
 * Subtitle — Cloudflare Worker
 *
 * Routes:
 *   GET  /realtime  — WebSocket upgrade. Proxies a browser session to
 *                     two parallel gpt-realtime-translate upstreams
 *                     (one EN-out, one JP-out) using the client's own
 *                     OpenAI key (BYOK). First client message must be
 *                     {type:"auth", key:"sk-..."}; without it we close.
 *   *               — falls through to static assets bound as env.ASSETS
 *                     (index.html, js/pcm-worklet.js, …).
 *
 * The key never gets logged. It exists only in this Worker invocation's
 * memory for the duration of the WebSocket session and on the wire
 * between this Worker and api.openai.com.
 */

// Cloudflare Workers fetch() requires the https:// scheme for WebSocket
// upgrades; it rejects wss:// even with Upgrade: websocket. The actual
// transport is still WSS — the protocol upgrade happens after the
// handshake.
const REALTIME_URL =
  "https://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate";

// Map of OpenAI event types → the kind we forward to the client.
// "delta"        = a translation chunk (output language)
// "input_delta"  = a source-language transcription chunk (input language)
//
// The translations endpoint (gpt-realtime-translate) uses session.*
// events — different from the standard /v1/realtime endpoint which
// uses conversation.item.* and response.* patterns. Verified by
// direct probe in June 2026.
const DELTA_EVENTS = {
  "session.output_transcript.delta": "delta",
  "session.input_transcript.delta": "input_delta",
};
const INPUT_DONE_EVENTS = new Set([
  "session.input_transcript.done",
  "session.input_transcript.completed",
]);
const DONE_EVENTS = new Set([
  "session.output_transcript.done",
]);

// Detect CJK characters (kanji + hiragana + katakana + JP punctuation).
// Used to route input transcription deltas by the language of the text
// rather than which upstream produced them — both upstreams transcribe
// the same audio.
function hasCJK(text) {
  return /[　-鿿＀-￯]/.test(text);
}

// ── Entry point ────────────────────────────────────────────────────────
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === "/realtime") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      return handleRealtime(req, ctx);
    }

    // Everything else → static assets
    if (env.ASSETS) {
      // The asset bound directory contains index.html which we serve at /,
      // js/pcm-worklet.js, etc.
      return env.ASSETS.fetch(req);
    }
    return new Response("Not Found", { status: 404 });
  },
};

// ── WebSocket upgrade handler ──────────────────────────────────────────
function handleRealtime(req, ctx) {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  // Run the session in the background; ctx.waitUntil keeps the Worker
  // alive until the session completes.
  ctx.waitUntil(runSession(server).catch((e) => console.error("session:", e)));

  return new Response(null, { status: 101, webSocket: client });
}

// ── Per-session orchestration ──────────────────────────────────────────
async function runSession(client) {
  let key;
  try {
    key = await waitForAuth(client);
  } catch (e) {
    safeSend(client, { type: "error", message: "auth timeout" });
    safeClose(client, 1008, "auth timeout");
    return;
  }
  if (!key) {
    safeSend(client, { type: "error", message: "missing OpenAI key" });
    safeClose(client, 1008, "auth required");
    return;
  }

  let enUp, jaUp;
  try {
    [enUp, jaUp] = await Promise.all([
      openUpstream(key, "en"),
      openUpstream(key, "ja"),
    ]);
  } catch (e) {
    const msg = e && e.message ? e.message : "upstream connect failed";
    safeSend(client, { type: "error", message: msg });
    safeClose(client, 1011, "upstream failed");
    return;
  }

  safeSend(client, { type: "ready" });

  setupUpstreamPump(enUp, "en", client);
  setupUpstreamPump(jaUp, "ja", client);

  // Pump browser → both upstreams. Audio frames are forwarded to both.
  client.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "audio" && msg.data) {
      const payload = JSON.stringify({
        type: "session.input_audio_buffer.append",
        audio: msg.data,
      });
      try { enUp.send(payload); } catch {}
      try { jaUp.send(payload); } catch {}
    } else if (msg.type === "ping") {
      safeSend(client, { type: "pong" });
    }
    // Ignore auth messages after the first (already handled).
  });

  const closeAll = () => {
    safeClose(enUp);
    safeClose(jaUp);
    safeClose(client);
  };
  client.addEventListener("close", closeAll);
  client.addEventListener("error", closeAll);
}

// Wait for the first client message and resolve with the key if it's an
// auth frame. Rejects on timeout (10s). Resolves with null if a message
// arrives but it's not a valid auth frame.
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

// Open one upstream WebSocket to gpt-realtime-translate. outputLang =
// "en" or "ja". Sends the session.update before returning.
async function openUpstream(key, outputLang) {
  const res = await fetch(REALTIME_URL, {
    headers: {
      "Upgrade": "websocket",
      "Connection": "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Authorization": `Bearer ${key}`,
      // No OpenAI-Beta header — the Beta API was deprecated. The
      // gpt-realtime-translate endpoint is GA at /v1/realtime/translations.
    },
  });
  if (res.status !== 101 || !res.webSocket) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 300); } catch {}
    throw new Error(`upstream ${outputLang} HTTP ${res.status} ${detail}`);
  }
  const ws = res.webSocket;
  ws.accept();
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      audio: {
        input: { transcription: { model: "whisper-1" } },
        output: { language: outputLang },
      },
    },
  }));
  return ws;
}

// Forward translation/transcription deltas from one upstream to the
// client, tagged with the panel they belong to.
//
// Routing rules:
//   • OUTPUT transcript (translation) → panel = upstream's output language
//       en upstream → left panel,  ja upstream → right panel
//   • INPUT transcript (source) → panel = language of the text itself
//       Both upstreams emit input transcription for the same audio, so
//       we only forward it from the EN upstream (any single source is
//       enough) and route by language detection on the content.
function setupUpstreamPump(upstream, outLang, client) {
  upstream.addEventListener("message", (ev) => {
    let evt;
    try { evt = JSON.parse(ev.data); } catch { return; }
    const etype = evt.type || "";

    if (etype === "session.output_transcript.delta") {
      const text = evt.delta || evt.text || "";
      if (!text) return;
      const panel = outLang === "en" ? "left" : "right";
      safeSend(client, { type: "delta", panel, session: outLang, text });
      return;
    }

    if (etype === "session.input_transcript.delta") {
      // Dedup: only the EN upstream's input transcription propagates to
      // the client. The JA upstream's identical transcription would
      // double-render on the same panel.
      if (outLang !== "en") return;
      const text = evt.delta || evt.text || "";
      if (!text) return;
      const panel = hasCJK(text) ? "right" : "left";
      safeSend(client, { type: "input_delta", panel, session: outLang, text });
      return;
    }

    if (INPUT_DONE_EVENTS.has(etype)) {
      if (outLang !== "en") return;
      const text = evt.transcript || "";
      const panel = hasCJK(text) ? "right" : "left";
      safeSend(client, { type: "input_done", panel, session: outLang, text });
      return;
    }

    if (etype === "session.output_transcript.done") {
      const panel = outLang === "en" ? "left" : "right";
      safeSend(client, { type: "done", panel, session: outLang });
      return;
    }

    if (etype === "error" || etype.endsWith(".error")) {
      const msg =
        (evt.error && evt.error.message) || evt.message || "upstream error";
      safeSend(client, { type: "error", message: `${outLang}: ${msg}` });
      return;
    }
    // session.created / session.updated / output_audio.delta etc: ignore.
  });

  upstream.addEventListener("close", () => {
    safeSend(client, {
      type: "error",
      message: `${outLang} upstream closed`,
    });
  });
}

// ── Tiny helpers ───────────────────────────────────────────────────────
function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}
function safeClose(ws, code, reason) {
  try { ws.close(code, reason); } catch {}
}
