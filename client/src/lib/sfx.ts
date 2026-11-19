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
// Phase 20.1: the sound is PICKABLE (Settings → Entry sound) — every option
// is synthesized here (no audio assets), tuned to fit a premium trading
// platform: deep, metallic, cinematic. Labels read like brand names; the
// default is "saber" (the Vader-register lightsaber ignition from Phase 20).
// ---------------------------------------------------------------------------

/** cinematic impact — sub-bass boom + soft noise thump + metallic shimmer */
function cinematicImpact(): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + 0.05;
  for (const [type, f0, f1, g] of [
    ["sine", 62, 28, 0.24],
    ["triangle", 118, 46, 0.09],
  ] as const) {
    const osc = c.createOscillator();
    const gn = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f1, t0 + 0.9);
    gn.gain.setValueAtTime(g, t0);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 1.15);
    osc.connect(gn).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + 1.2);
  }
  const len = 0.3;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * len), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = c.createBufferSource();
  src.buffer = buf;
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 520;
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.3, t0);
  ng.gain.exponentialRampToValueAtTime(0.001, t0 + len);
  src.connect(lp).connect(ng).connect(c.destination);
  src.start(t0);
  src.stop(t0 + len);
  // glitter — quiet high partials with a long decay (the "expensive" tail)
  for (const [f, g] of [[2637, 0.018], [3520, 0.013], [4400, 0.009]] as const) {
    const osc = c.createOscillator();
    const gn = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f, t0 + 0.06);
    gn.gain.setValueAtTime(0.0001, t0 + 0.06);
    gn.gain.exponentialRampToValueAtTime(g, t0 + 0.12);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
    osc.connect(gn).connect(c.destination);
    osc.start(t0 + 0.06);
    osc.stop(t0 + 1.55);
  }
}

/** golden bell — one strike with an inharmonic partial series, long shimmer */
function goldenBell(): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + 0.05;
  const base = 523.25; // C5
  for (const [ratio, g, dur] of [
    [1.0, 0.16, 2.3],
    [2.0, 0.075, 1.7],
    [2.76, 0.06, 1.3],
    [5.4, 0.035, 0.9],
    [8.93, 0.02, 0.6],
  ] as const) {
    const osc = c.createOscillator();
    const gn = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(base * ratio, t0);
    gn.gain.setValueAtTime(0.0001, t0);
    gn.gain.exponentialRampToValueAtTime(g, t0 + 0.012);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gn).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
  // strike transient
  const len = 0.05;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * len), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 3200;
  bp.Q.value = 1.2;
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.12, t0);
  ng.gain.exponentialRampToValueAtTime(0.001, t0 + len);
  src.connect(bp).connect(ng).connect(c.destination);
  src.start(t0);
  src.stop(t0 + len);
}

/** cinematic riser — a noise sweep climbing into one soft grand hit */
function cinematicRiser(): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + 0.05;
  const rise = 1.3;
  const len = rise;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * len), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(300, t0);
  bp.frequency.exponentialRampToValueAtTime(3800, t0 + rise);
  bp.Q.value = 1.4;
  const g = c.createGain();
  g.gain.setValueAtTime(0.001, t0);
  g.gain.exponentialRampToValueAtTime(0.15, t0 + rise);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + rise + 0.08);
  src.connect(bp).connect(g).connect(c.destination);
  src.start(t0);
  src.stop(t0 + rise + 0.1);
  // a quiet tone riding the sweep
  const osc = c.createOscillator();
  const og = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(220, t0);
  osc.frequency.exponentialRampToValueAtTime(880, t0 + rise);
  og.gain.setValueAtTime(0.0001, t0);
  og.gain.exponentialRampToValueAtTime(0.05, t0 + rise);
  og.gain.exponentialRampToValueAtTime(0.0001, t0 + rise + 0.08);
  osc.connect(og).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + rise + 0.1);
  // the hit — one warm sub note + one air burst
  const hit = c.createOscillator();
  const hg = c.createGain();
  hit.type = "sine";
  hit.frequency.setValueAtTime(85, t0 + rise);
  hit.frequency.exponentialRampToValueAtTime(40, t0 + rise + 0.5);
  hg.gain.setValueAtTime(0.2, t0 + rise);
  hg.gain.exponentialRampToValueAtTime(0.001, t0 + rise + 0.7);
  hit.connect(hg).connect(c.destination);
  hit.start(t0 + rise);
  hit.stop(t0 + rise + 0.75);
  const nlen = 0.45;
  const nbuf = c.createBuffer(1, Math.ceil(c.sampleRate * nlen), c.sampleRate);
  const nd = nbuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / nd.length);
  const nsrc = c.createBufferSource();
  nsrc.buffer = nbuf;
  const nlp = c.createBiquadFilter();
  nlp.type = "lowpass";
  nlp.frequency.value = 2600;
  const ngain = c.createGain();
  ngain.gain.setValueAtTime(0.12, t0 + rise);
  ngain.gain.exponentialRampToValueAtTime(0.001, t0 + rise + nlen);
  nsrc.connect(nlp).connect(ngain).connect(c.destination);
  nsrc.start(t0 + rise);
  nsrc.stop(t0 + rise + nlen);
}

/** vault unlock — dialing clicks, a heavy clunk, deep door hum, final tick */
function vaultUnlock(): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + 0.05;
  [0, 0.14, 0.28].forEach((dt, i) => {
    const osc = c.createOscillator();
    const gn = c.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(i === 2 ? 1750 : 1350, t0 + dt);
    gn.gain.setValueAtTime(0.11, t0 + dt);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + dt + 0.03);
    osc.connect(gn).connect(c.destination);
    osc.start(t0 + dt);
    osc.stop(t0 + dt + 0.04);
  });
  // the clunk — heavy metal falling into the lock
  const clunk = c.createOscillator();
  const cg = c.createGain();
  clunk.type = "sine";
  clunk.frequency.setValueAtTime(165, t0 + 0.42);
  clunk.frequency.exponentialRampToValueAtTime(58, t0 + 0.72);
  cg.gain.setValueAtTime(0.26, t0 + 0.42);
  cg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.82);
  clunk.connect(cg).connect(c.destination);
  clunk.start(t0 + 0.42);
  clunk.stop(t0 + 0.85);
  const mlen = 0.18;
  const mbuf = c.createBuffer(1, Math.ceil(c.sampleRate * mlen), c.sampleRate);
  const md = mbuf.getChannelData(0);
  for (let i = 0; i < md.length; i++) md[i] = (Math.random() * 2 - 1) * (1 - i / md.length);
  const msrc = c.createBufferSource();
  msrc.buffer = mbuf;
  const mlp = c.createBiquadFilter();
  mlp.type = "lowpass";
  mlp.frequency.value = 420;
  const mg = c.createGain();
  mg.gain.setValueAtTime(0.22, t0 + 0.42);
  mg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.42 + mlen);
  msrc.connect(mlp).connect(mg).connect(c.destination);
  msrc.start(t0 + 0.42);
  msrc.stop(t0 + 0.42 + mlen);
  // deep door hum — the vault breathing open
  const hum = c.createOscillator();
  const hlp = c.createBiquadFilter();
  const hg = c.createGain();
  hum.type = "sawtooth";
  hum.frequency.value = 55;
  hlp.type = "lowpass";
  hlp.frequency.value = 260;
  hg.gain.setValueAtTime(0.0001, t0 + 0.5);
  hg.gain.exponentialRampToValueAtTime(0.09, t0 + 0.7);
  hg.gain.setValueAtTime(0.09, t0 + 1.0);
  hg.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
  hum.connect(hlp).connect(hg).connect(c.destination);
  hum.start(t0 + 0.5);
  hum.stop(t0 + 1.55);
  // the lock clicks shut
  const lock = c.createOscillator();
  const lg = c.createGain();
  lock.type = "square";
  lock.frequency.setValueAtTime(2100, t0 + 1.05);
  lg.gain.setValueAtTime(0.08, t0 + 1.05);
  lg.gain.exponentialRampToValueAtTime(0.001, t0 + 1.09);
  lock.connect(lg).connect(c.destination);
  lock.start(t0 + 1.05);
  lock.stop(t0 + 1.1);
}

/** coin cascade — scattered gold tings resolving into a warm major chord */
function coinCascade(): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + 0.05;
  const pings: [number, number][] = [
    [2793, 0], [3520, 0.09], [2489, 0.2], [3135, 0.33], [2793, 0.46], [3520, 0.58],
  ];
  for (const [f, dt] of pings) {
    const osc = c.createOscillator();
    const gn = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f, t0 + dt);
    osc.frequency.exponentialRampToValueAtTime(f * 0.92, t0 + dt + 0.22);
    gn.gain.setValueAtTime(0.09, t0 + dt);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + dt + 0.26);
    osc.connect(gn).connect(c.destination);
    osc.start(t0 + dt);
    osc.stop(t0 + dt + 0.3);
    // overtone for the metallic ring
    const o2 = c.createOscillator();
    const g2 = c.createGain();
    o2.type = "sine";
    o2.frequency.setValueAtTime(f * 2.7, t0 + dt);
    g2.gain.setValueAtTime(0.018, t0 + dt);
    g2.gain.exponentialRampToValueAtTime(0.001, t0 + dt + 0.14);
    o2.connect(g2).connect(c.destination);
    o2.start(t0 + dt);
    o2.stop(t0 + dt + 0.18);
  }
  // the settle — a soft warm chord under the last tings
  [523.25, 659.25, 783.99].forEach((f, i) => {
    const osc = c.createOscillator();
    const gn = c.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(f, t0 + 0.78 + i * 0.02);
    gn.gain.setValueAtTime(0.0001, t0 + 0.78 + i * 0.02);
    gn.gain.exponentialRampToValueAtTime(0.06, t0 + 0.82 + i * 0.02);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
    osc.connect(gn).connect(c.destination);
    osc.start(t0 + 0.78 + i * 0.02);
    osc.stop(t0 + 1.55);
  });
}

export type EntrySoundId = "saber" | "impact" | "bell" | "riser" | "vault" | "coins" | "none";

/** the pickable entry-sound list (Settings → Entry sound) */
export const ENTRY_SOUNDS: { id: EntrySoundId; label: string }[] = [
  { id: "saber", label: "Lightsaber" },
  { id: "impact", label: "Cinematic Impact" },
  { id: "bell", label: "Golden Bell" },
  { id: "riser", label: "Cinematic Riser" },
  { id: "vault", label: "Vault Unlock" },
  { id: "coins", label: "Coin Cascade" },
  { id: "none", label: "Silent" },
];

const ENTRY_SOUND_KEY = "tj-entry-sound";

function isEntrySound(v: string | null): v is EntrySoundId {
  return v !== null && ENTRY_SOUNDS.some((s) => s.id === v);
}

export function getEntrySound(): EntrySoundId {
  try {
    const v = localStorage.getItem(ENTRY_SOUND_KEY);
    return isEntrySound(v) ? v : "saber";
  } catch {
    return "saber";
  }
}

export function setEntrySound(id: EntrySoundId): void {
  try { localStorage.setItem(ENTRY_SOUND_KEY, id); } catch { /* private mode */ }
}

/** play one entry sound by id — preview and the splash share this path */
export function playEntrySound(id: EntrySoundId): void {
  switch (id) {
    case "saber": entrySaber(); break;
    case "impact": cinematicImpact(); break;
    case "bell": goldenBell(); break;
    case "riser": cinematicRiser(); break;
    case "vault": vaultUnlock(); break;
    case "coins": coinCascade(); break;
    case "none": break;
  }
}

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
 * Play the chosen entry sound once per tab session. Autoplay policy: browsers
 * keep the AudioContext suspended until a user gesture, so on a cold load the
 * sound waits for the first pointer/key press (usually the login click while
 * the splash is still up) instead of failing silently forever. "Silent"
 * (none) plays nothing and skips the listeners entirely.
 */
export function playEntryChimeOnce(): void {
  if (entrySoundPlayed || typeof window === "undefined") return;
  entrySoundPlayed = true;
  const id = getEntrySound();
  if (id === "none") return;
  const c = audio();
  if (c && c.state === "running") {
    playEntrySound(id);
    return;
  }
  const tryPlay = () => {
    window.removeEventListener("pointerdown", tryPlay);
    window.removeEventListener("keydown", tryPlay);
    const c2 = audio();
    if (c2 && c2.state === "running") playEntrySound(getEntrySound());
  };
  window.addEventListener("pointerdown", tryPlay);
  window.addEventListener("keydown", tryPlay);
  // give up after 30s — never leave listeners dangling for the whole session
  setTimeout(() => {
    window.removeEventListener("pointerdown", tryPlay);
    window.removeEventListener("keydown", tryPlay);
  }, 30000);
}
