/**
 * FIR-based PCM16 resampler.
 *
 * This is the single resampling implementation used for both live and
 * historical audio playback, ensuring they sound identical.
 *
 * For integer ratios (e.g. 12 kHz → 48 kHz = 4×) it uses zero-stuffing
 * + an 81-tap Hamming-windowed FIR anti-aliasing filter.
 *
 * For non-integer ratios it falls back to linear interpolation.
 */

export interface ResamplerState {
  carryPos: number;
  lastSample: number;
  hasLast: boolean;
  firFactor: number;
  firTaps: Float32Array;
  firTail: Float32Array;
}

export function createResamplerState(): ResamplerState {
  return {
    carryPos: 0,
    hasLast: false,
    lastSample: 0,
    firFactor: 0,
    firTaps: new Float32Array(0),
    firTail: new Float32Array(0),
  };
}

function buildFIRTaps(factor: number): Float32Array {
  const transitionBandwidth = 0.05;
  let numTaps = Math.round(4 / transitionBandwidth);
  if (numTaps % 2 === 0) numTaps += 1;
  const taps = new Float32Array(numTaps);
  const mid = Math.floor(numTaps / 2);
  const cutoff = 1 / factor / 2;
  const hamming = (r: number) => {
    const rate = 0.5 + r / 2;
    return 0.54 - 0.46 * Math.cos(2 * Math.PI * rate);
  };
  taps[mid] = 2 * Math.PI * cutoff * hamming(0);
  for (let i = 1; i <= mid; i++) {
    const value =
      (Math.sin(2 * Math.PI * cutoff * i) / i) * hamming(i / mid);
    taps[mid - i] = value;
    taps[mid + i] = value;
  }
  let sum = 0;
  for (let i = 0; i < taps.length; i++) sum += taps[i];
  for (let i = 0; i < taps.length; i++) taps[i] /= sum;
  return taps;
}

function upsampleByIntegerFIR(
  input: Int16Array,
  factor: number,
  state: ResamplerState,
): Float32Array {
  if (state.firFactor !== factor || state.firTaps.length === 0) {
    state.firFactor = factor;
    state.firTaps = buildFIRTaps(factor);
    state.firTail = new Float32Array(state.firTaps.length - 1);
  }
  const taps = state.firTaps;
  const tail = state.firTail;
  const upLen = input.length * factor;
  const up = new Float32Array(upLen);
  for (let i = 0; i < input.length; i++) {
    up[i * factor] = input[i] / 32768;
  }
  const work = new Float32Array(tail.length + up.length);
  work.set(tail, 0);
  work.set(up, tail.length);

  const out = new Float32Array(upLen);
  const tapCount = taps.length;
  const start = tapCount - 1;
  for (let wi = start; wi < work.length; wi++) {
    let acc = 0;
    for (let k = 0; k < tapCount; k++) {
      acc += work[wi - k] * taps[k];
    }
    out[wi - start] = factor * acc;
  }

  state.firTail = work.slice(work.length - (tapCount - 1));
  return out;
}

/**
 * Resample PCM16 audio from inRate to outRate, using the same FIR filter
 * for both streaming (live) and one-shot (historical) audio.
 *
 * For streaming use, pass a persistent `state` to maintain filter
 * continuity across calls. For one-shot use, pass a fresh state.
 */
export function resamplePCM(
  input: Int16Array,
  inRate: number,
  outRate: number,
  state: ResamplerState,
): Float32Array {
  if (input.length === 0) return new Float32Array(0);
  if (!inRate || !outRate) return new Float32Array(0);

  if (inRate === outRate) {
    const passthrough = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      passthrough[i] = input[i] / 32768;
    }
    return passthrough;
  }

  if (outRate % inRate === 0) {
    return upsampleByIntegerFIR(input, outRate / inRate, state);
  }

  const step = inRate / outRate;
  const srcLen = input.length + (state.hasLast ? 1 : 0);
  const src = new Int16Array(srcLen);
  if (state.hasLast) {
    src[0] = state.lastSample;
    src.set(input, 1);
  } else {
    src.set(input);
  }
  const out: number[] = [];
  let pos = state.carryPos;
  while (pos + 1 < src.length) {
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = src[idx];
    const s1 = src[idx + 1];
    out.push((s0 + (s1 - s0) * frac) / 32768);
    pos += step;
  }
  state.lastSample = src[src.length - 1];
  state.hasLast = true;
  state.carryPos = pos - (src.length - 1);
  if (
    !Number.isFinite(state.carryPos) ||
    state.carryPos < 0 ||
    state.carryPos >= 1
  ) {
    state.carryPos = 0;
  }
  return Float32Array.from(out);
}

/**
 * Parse the raw PCM16 samples out of a WAV ArrayBuffer,
 * returning the sample data and the source sample rate.
 */
export function parseWavPCM16(wav: ArrayBuffer): {
  samples: Int16Array;
  sampleRate: number;
} {
  const view = new DataView(wav);
  const sampleRate = view.getUint32(24, true);
  const dataOffset = 44;
  const dataLen = wav.byteLength - dataOffset;
  const samples = new Int16Array(wav, dataOffset, dataLen / 2);
  return { samples, sampleRate };
}

/**
 * Decode a WAV ArrayBuffer into a 48 kHz Float32Array using the same
 * FIR resampler that the live audio path uses.
 *
 * Returns a ready-to-use AudioBuffer at the AudioContext's sample rate.
 */
export function decodeAndResampleWav(
  wav: ArrayBuffer,
  ctx: AudioContext,
): AudioBuffer {
  const { samples, sampleRate } = parseWavPCM16(wav);
  const state = createResamplerState();
  const resampled = resamplePCM(samples, sampleRate, ctx.sampleRate, state);
  const buf = ctx.createBuffer(1, resampled.length, ctx.sampleRate);
  buf.getChannelData(0).set(resampled);
  return buf;
}
