/**
 * Tiny WebAudio synth for the case-opening sequence — no audio assets.
 * All sounds are short synthesized bursts (thuds / ticks / chimes) built
 * from oscillators + noise, scheduled on a lazily created AudioContext.
 * Safe to call anywhere: browsers without WebAudio or before a user
 * gesture simply no-op (the case UI only calls these from click flows).
 */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (typeof window === "undefined") return null;
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** one filtered noise burst — the "thud" of the case rattling */
function thud(c: AudioContext, at: number, gain = 0.5) {
  const len = 0.09;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * len), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 320;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + len);
  src.connect(filter).connect(g).connect(c.destination);
  src.start(at);
  src.stop(at + len);
}

/** short metallic tick — one reel item flying past the pointer line */
function tick(c: AudioContext, at: number, pitch = 1500, gain = 0.12) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(pitch, at);
  osc.frequency.exponentialRampToValueAtTime(pitch * 0.55, at + 0.035);
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
  osc.connect(g).connect(c.destination);
  osc.start(at);
  osc.stop(at + 0.06);
}

/** the lid pops + the reel drops in — a quick rising swoosh */
function swoosh(c: AudioContext, at: number) {
  const len = 0.28;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * len), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (i / data.length);
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(500, at);
  filter.frequency.exponentialRampToValueAtTime(3200, at + len);
  filter.Q.value = 2;
  const g = c.createGain();
  g.gain.setValueAtTime(0.22, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + len);
  src.connect(filter).connect(g).connect(c.destination);
  src.start(at);
  src.stop(at + len);
}

/** one pure note of the winner chime */
function note(c: AudioContext, at: number, freq: number, dur = 0.32, gain = 0.2, type: OscillatorType = "triangle") {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  osc.connect(g).connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

const RATTLE_MS = 1300; // SHAKE_MS in CaseOpeningDialog
const SPIN_MS = 5100; // SPIN_MS in CaseOpeningDialog

/** the case rattles before it pops — five thuds over the shake phase */
export function caseRattle(): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + 0.02;
  const times = [0, 0.26, 0.52, 0.78, 1.02];
  times.forEach((t, i) => thud(c, t0 + t, 0.42 - i * 0.04));
}

/** the lid pops open and the reel drops in */
export function casePop(): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + 0.02;
  swoosh(c, t0);
  thud(c, t0 + 0.26, 0.5);
}

/**
 * Reel spin: rapid ticks that decelerate like the visual scroll
 * (fast at the start, crawling into the stop — matches the cubic-bezier).
 */
export function caseSpin(durationMs = SPIN_MS): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + 0.02;
  const total = durationMs / 1000;
  // ease-out curve for the gaps: 38ms at the start → ~340ms at the end
  let t = 0;
  for (let i = 0; t < total - 0.05; i++) {
    const p = i / 42;
    const gap = 0.038 + 0.3 * Math.min(1, p) ** 2.2;
    tick(c, t0 + t, 1500 - i * 8, 0.1 + 0.04 * Math.min(1, p));
    t += gap;
  }
  // final settle thud when the reel stops
  thud(c, t0 + total, 0.45);
}

/** winner reveal — arpeggio; mythic gets a longer, richer fanfare */
export function caseReveal(rarity: string): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + 0.02;
  if (rarity === "mythic") {
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => note(c, t0 + i * 0.11, f, 0.5, 0.22));
    [2093, 2637].forEach((f, i) => note(c, t0 + 0.55 + i * 0.16, f, 0.7, 0.1, "sine"));
  } else if (rarity === "covert") {
    [523.25, 659.25, 783.99].forEach((f, i) => note(c, t0 + i * 0.1, f, 0.42, 0.2));
    note(c, t0 + 0.3, 1046.5, 0.55, 0.18);
  } else if (rarity === "epic") {
    [440, 554.37, 659.25].forEach((f, i) => note(c, t0 + i * 0.09, f, 0.35, 0.18));
  } else if (rarity === "rare") {
    [392, 493.88].forEach((f, i) => note(c, t0 + i * 0.09, f, 0.3, 0.16));
  } else {
    note(c, t0, 329.63, 0.26, 0.14);
  }
}

// ---------------------------------------------------------------------------
// Entry chime — the brand sound under the InspireTrade splash screen.
// A soft rising C-major motif (C5 → E5 → G5 → C6) with a low pad underneath:
// ~1.6s, quiet enough to sit under the loading animation, not startle.
// ---------------------------------------------------------------------------

/** one soft chime note with a gentle detuned double (warmth) */
function chimeNote(c: AudioContext, at: number, freq: number, dur: number, gain: number) {
  for (const [type, g, det] of [["triangle", 1, 0], ["sine", 0.35, 3]] as const) {
    const osc = c.createOscillator();
    const gn = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq + det, at);
    gn.gain.setValueAtTime(0.0001, at);
    gn.gain.exponentialRampToValueAtTime(gain * g, at + 0.03);
    gn.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gn).connect(c.destination);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }
}

function entryChime(): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + 0.05;
  // low pad holds under the whole motif
  chimeNote(c, t0, 261.63, 1.5, 0.05);
  // the rising motif
  [523.25, 659.25, 783.99].forEach((f, i) => chimeNote(c, t0 + i * 0.16, f, 0.5, 0.11));
  // settle on the octave — the "arrived" note as the splash hands over
  chimeNote(c, t0 + 0.52, 1046.5, 0.9, 0.1);
}

let entryChimePlayed = false;

/**
 * Play the splash chime once per tab session. Autoplay policy: browsers keep
 * the AudioContext suspended until a user gesture, so on a cold load the
 * chime waits for the first pointer/key press (usually the login click while
 * the splash is still up) instead of failing silently forever.
 */
export function playEntryChimeOnce(): void {
  if (entryChimePlayed || typeof window === "undefined") return;
  entryChimePlayed = true;
  const c = audio();
  if (c && c.state === "running") {
    entryChime();
    return;
  }
  const tryPlay = () => {
    window.removeEventListener("pointerdown", tryPlay);
    window.removeEventListener("keydown", tryPlay);
    const c2 = audio();
    if (c2 && c2.state === "running") entryChime();
  };
  window.addEventListener("pointerdown", tryPlay);
  window.addEventListener("keydown", tryPlay);
  // give up after 30s — never leave listeners dangling for the whole session
  setTimeout(() => {
    window.removeEventListener("pointerdown", tryPlay);
    window.removeEventListener("keydown", tryPlay);
  }, 30000);
}
