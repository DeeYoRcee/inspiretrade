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
// Entry sound — the brand sound under the InspireTrade splash screen.
// Phase 20: a synthesized lightsaber ignition (Darth Vader register — deep,
// menacing hum): the blade snaps on with a noise hiss, the oscillator sweeps
// up into a detuned saw hum with the classic slow "woo-woo" wobble, then the
// blade powers down. ~1.8s, quiet enough to sit under the splash animation.
// ---------------------------------------------------------------------------

/** lightsaber ignition — hiss + rising detuned hum + wobble + power-down */
function entrySaber(): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + 0.05;
  const dur = 1.8;

  const master = c.createGain();
  master.gain.setValueAtTime(0.0001, t0);
  master.gain.exponentialRampToValueAtTime(0.15, t0 + 0.14); // the blade snaps on
  master.gain.setValueAtTime(0.15, t0 + dur - 0.55);
  master.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); // powers down
  master.connect(c.destination);

  // the hum — two detuned saws + a sub octave through a resonant lowpass
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(380, t0);
  filter.frequency.linearRampToValueAtTime(920, t0 + 0.3); // opens as it ignites
  filter.Q.value = 7;
  filter.connect(master);
  const hums: { osc: OscillatorNode }[] = [];
  for (const [type, freq, g] of [
    ["sawtooth", 58, 1],
    ["sawtooth", 60.7, 0.8],   // 2.7 Hz beat against the first saw
    ["square", 29, 0.5],       // sub — the Vader-depth
  ] as const) {
    const osc = c.createOscillator();
    const gn = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq * 0.4, t0);
    osc.frequency.exponentialRampToValueAtTime(freq, t0 + 0.32); // rise into the hum
    gn.gain.setValueAtTime(g, t0);
    osc.connect(gn).connect(filter);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    hums.push({ osc });
  }

  // the classic slow "woo-woo" — amplitude wobble + a drifting pitch wobble
  const lfo = c.createOscillator();
  const lfoGain = c.createGain();
  lfo.type = "sine";
  lfo.frequency.value = 5.6;
  lfoGain.gain.value = 0.045;
  lfo.connect(lfoGain).connect(master.gain);
  lfo.start(t0);
  lfo.stop(t0 + dur + 0.05);
  const wob = c.createOscillator();
  const wobGain = c.createGain();
  wob.type = "sine";
  wob.frequency.value = 0.9;
  wobGain.gain.value = 1.3;
  wob.start(t0);
  wob.stop(t0 + dur + 0.05);
  for (const { osc } of hums) wobGain.connect(osc.frequency); // ±1.3 Hz drift
  wob.connect(wobGain);

  // ignition hiss — a noise burst through a bandpass sweeping up
  const len = 0.5;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * len), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(900, t0);
  bp.frequency.exponentialRampToValueAtTime(2600, t0 + 0.28);
  bp.Q.value = 1.6;
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.4, t0);
  ng.gain.exponentialRampToValueAtTime(0.001, t0 + len);
  src.connect(bp).connect(ng).connect(c.destination);
  src.start(t0);
  src.stop(t0 + len);
}

let entrySoundPlayed = false;

/**
 * Play the splash sound once per tab session. Autoplay policy: browsers keep
 * the AudioContext suspended until a user gesture, so on a cold load the
 * saber waits for the first pointer/key press (usually the login click while
 * the splash is still up) instead of failing silently forever.
 */
export function playEntryChimeOnce(): void {
  if (entrySoundPlayed || typeof window === "undefined") return;
  entrySoundPlayed = true;
  const c = audio();
  if (c && c.state === "running") {
    entrySaber();
    return;
  }
  const tryPlay = () => {
    window.removeEventListener("pointerdown", tryPlay);
    window.removeEventListener("keydown", tryPlay);
    const c2 = audio();
    if (c2 && c2.state === "running") entrySaber();
  };
  window.addEventListener("pointerdown", tryPlay);
  window.addEventListener("keydown", tryPlay);
  // give up after 30s — never leave listeners dangling for the whole session
  setTimeout(() => {
    window.removeEventListener("pointerdown", tryPlay);
    window.removeEventListener("keydown", tryPlay);
  }, 30000);
}
