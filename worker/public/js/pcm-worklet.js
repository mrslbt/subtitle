/**
 * pcm-worklet.js — runs in the AudioWorkletGlobalScope.
 *
 * Pulls Float32 audio from the mic input at the AudioContext's native
 * sample rate (usually 48000 on macOS, 44100 on iOS), downsamples to
 * 24000 Hz mono (what gpt-realtime-translate expects), converts to
 * little-endian PCM16, and posts each ~100ms frame to the main thread
 * as a transferable ArrayBuffer.
 *
 * The main thread base64-encodes and ships the frame over WebSocket
 * to the server, which forwards it to OpenAI Realtime.
 *
 * Resampling note: we use linear-interpolation downsampling without
 * an anti-aliasing low-pass. For 48k → 24k that's technically a
 * Nyquist violation above 12 kHz, but human speech rolls off well
 * below that and Whisper-class models are trained on a lot of
 * imperfectly-filtered audio. This is the same shortcut every
 * browser-side voice client takes; it sounds fine.
 */

const TARGET_SAMPLE_RATE = 24000;
const FRAME_MS = 100;  // send every ~100ms — low latency, reasonable WS overhead

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._sourceRate = sampleRate;  // AudioContext rate (global in worklet scope)
    this._ratio = this._sourceRate / TARGET_SAMPLE_RATE;
    this._targetFrameSamples = Math.round(TARGET_SAMPLE_RATE * FRAME_MS / 1000);
    this._buffer = new Float32Array(this._targetFrameSamples);
    this._bufLen = 0;
    this._resampleAcc = 0;  // fractional accumulator for downsample
  }

  /**
   * Pulls one render quantum (128 samples by default at sourceRate).
   * Downsamples in-line by stepping through input with a fractional
   * accumulator and emitting samples at integer index boundaries.
   */
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];  // mono — take channel 0

    // Downsample loop. For ratio=2 (48k→24k), we emit every other sample.
    // For non-integer ratios (e.g. 44.1k→24k = 1.8375), we linearly
    // interpolate between adjacent input samples.
    for (let i = 0; i < ch.length; i++) {
      this._resampleAcc += 1;
      while (this._resampleAcc >= this._ratio) {
        this._resampleAcc -= this._ratio;
        // Linear interpolation between sample i-1 and i, weighted by
        // how far past i the fractional position landed.
        const frac = this._resampleAcc / this._ratio;
        const prev = i > 0 ? ch[i - 1] : 0;
        const cur = ch[i];
        const out = prev * frac + cur * (1 - frac);
        this._buffer[this._bufLen++] = out;
        if (this._bufLen >= this._targetFrameSamples) {
          this._flush();
        }
      }
    }
    return true;
  }

  _flush() {
    // Convert Float32 [-1, 1] → Int16 little-endian PCM
    const pcm16 = new Int16Array(this._bufLen);
    for (let i = 0; i < this._bufLen; i++) {
      let s = this._buffer[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      pcm16[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF);
    }
    // Transfer the underlying buffer (zero-copy) to main thread.
    this.port.postMessage({ pcm16: pcm16.buffer }, [pcm16.buffer]);
    this._bufLen = 0;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
