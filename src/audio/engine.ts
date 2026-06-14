// The WebAudio graph for the GTO-inverter EMU (HLD §2.4) — impure adapter.
//
// All the logic worth testing lives in `audioParams` (params.ts); this module
// is pure wiring: it builds one AudioContext and a fixed graph, then on each
// `update(p)` nudges node frequencies/gains toward the params via
// setTargetAtTime for smoothness. `start()` resumes the context (call on the
// first user gesture — browser autoplay policy). If WebAudio is unavailable it
// degrades to a no-op so the app still runs (headless / unsupported).

import type { AudioParams } from "./params";

export interface AudioEngine {
  /** Resume the AudioContext (call on first user gesture). */
  start(): void;
  /** Push the latest sim-derived params into the graph. */
  update(p: AudioParams): void;
}

const SMOOTH = 0.06; // setTargetAtTime time-constant, s (smooth but responsive)
const MASTER = 0.35; // headroom so the layered sources don't clip

/** Build a white-noise buffer (mono, ~1 s) for the looping noise sources. */
function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * Create the audio engine. Guards AudioContext creation: any failure (no
 * WebAudio, blocked) yields a graceful no-op engine.
 */
export function createAudioEngine(): AudioEngine {
  const Ctor: typeof AudioContext | undefined =
    typeof window !== "undefined"
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;

  if (!Ctor) {
    // No WebAudio — no-op engine (the app still runs / builds).
    return { start: () => {}, update: () => {} };
  }

  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return { start: () => {}, update: () => {} };
  }

  const master = ctx.createGain();
  master.gain.value = MASTER;
  master.connect(ctx.destination);

  // ── Whine: two detuned oscillators (saw + triangle) through a gain ─────────
  const whineGain = ctx.createGain();
  whineGain.gain.value = 0;
  whineGain.connect(master);
  const oscSaw = ctx.createOscillator();
  oscSaw.type = "sawtooth";
  oscSaw.frequency.value = 60;
  const oscTri = ctx.createOscillator();
  oscTri.type = "triangle";
  oscTri.frequency.value = 60;
  oscTri.detune.value = 7; // slight beat for a richer inverter tone
  oscSaw.connect(whineGain);
  oscTri.connect(whineGain);

  // ── Rolling: looping noise through a low-pass, scaled by speed ─────────────
  const noiseBuf = makeNoiseBuffer(ctx);
  const rollSrc = ctx.createBufferSource();
  rollSrc.buffer = noiseBuf;
  rollSrc.loop = true;
  const rollFilter = ctx.createBiquadFilter();
  rollFilter.type = "lowpass";
  rollFilter.frequency.value = 420; // rumble
  const rollGain = ctx.createGain();
  rollGain.gain.value = 0;
  rollSrc.connect(rollFilter).connect(rollGain).connect(master);

  // ── Brake hiss: looping noise through a high-pass ──────────────────────────
  const hissSrc = ctx.createBufferSource();
  hissSrc.buffer = noiseBuf;
  hissSrc.loop = true;
  const hissFilter = ctx.createBiquadFilter();
  hissFilter.type = "highpass";
  hissFilter.frequency.value = 2200; // airy hiss
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0;
  hissSrc.connect(hissFilter).connect(hissGain).connect(master);

  let started = false;
  function start(): void {
    if (started) return;
    started = true;
    try {
      oscSaw.start();
      oscTri.start();
      rollSrc.start();
      hissSrc.start();
    } catch {
      /* already started — ignore */
    }
    void ctx.resume();
  }

  function set(param: AudioParam, target: number): void {
    const t = Number.isFinite(target) ? target : 0;
    param.setTargetAtTime(t, ctx.currentTime, SMOOTH);
  }

  function update(p: AudioParams): void {
    set(oscSaw.frequency, p.whineHz);
    set(oscTri.frequency, p.whineHz);
    // Whine audibility: traction gain, modest level so it sits under the mix.
    set(whineGain.gain, 0.18 * p.tractionGain);
    set(rollGain.gain, 0.5 * p.rollGain);
    set(hissGain.gain, 0.4 * p.brakeHissGain);
  }

  return { start, update };
}
