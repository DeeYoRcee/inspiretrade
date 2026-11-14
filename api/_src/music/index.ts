/**
 * Full-length music catalog + stream resolver for the in-app music player.
 * Dispatched from /api/news?music=search&q=… and ?music=stream&id=… — the
 * public read-only function hosts it because the Hobby plan sits at its
 * 12-function cap and cannot add another endpoint.
 *
 * Everything runs SERVER-side (Vercel egress), so browser CORS never
 * matters. Cascade, first success wins (hosts raced in parallel, 5s cap):
 *   search: Piped music_songs → Invidious video search
 *   stream: Piped audio streams (proxied, not IP-locked) → InnerTube
 *           ANDROID player → Invidious latest_version proxied redirect
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PIPED_HOSTS = [
  "https://pipedapi.kavin.rocks",
  "https://api.piped.private.coffee",
  "https://pipedapi.drgns.space",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.leptons.xyz",
  "https://piped-api.lunar.icu",
  "https://pipedapi.ducks.party",
  "https://pipedapi.reallyaweso.me",
  "https://pipedapi.nosebs.ru",
  "https://pipedapi.orangenet.cc",
  "https://api.piped.privacydev.net",
  "https://pipedapi.owo.si",
  "https://pipedapi.phoenixthrush.com",
];

const INV_HOSTS = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://yewtu.be",
  "https://invidious.private.coffee",
  "https://iv.datura.network",
  "https://invidious.f5.si",
  "https://iv.ggtyler.dev",
  "https://invidious.jing.rocks",
  "https://iv.melmac.space",
  "https://invidious.fdn.fr",
];

async function jget(url: string, ms = 5000): Promise<any | null> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    const r = await fetch(url, { signal: c.signal, headers: { "user-agent": UA } });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** first FULFILLED result (all hosts raced in parallel); null when all fail */
async function firstOk<T>(jobs: Promise<T>[]): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let pending = jobs.length;
    let done = false;
    if (!pending) { resolve(null); return; }
    for (const job of jobs) {
      job.then(
        (v) => { if (!done) { done = true; resolve(v); } },
        () => { pending -= 1; if (pending === 0 && !done) resolve(null); },
      );
    }
  });
}

export interface MusicItem {
  id: string;
  title: string;
  author: string;
  duration: number;
  art: string;
  /** SoundCloud media transcodings URL — resolved server-side at play time
   *  (the /tracks/{id} endpoint is datacenter-blocked, so search rows carry
   *  their own resolution hint through the client) */
  hint?: string;
}

// ---- SoundCloud ------------------------------------------------------------
// FULL-LENGTH tracks wherever artists/labels allow streaming (policy!=="SNIPPET").
// The web client_id is scraped from SoundCloud's own JS bundles and cached 1h.

let scIdCache: { id: string; at: number } | null = null;

async function soundcloudClientId(): Promise<string | null> {
  if (scIdCache && Date.now() - scIdCache.at < 3600_000) return scIdCache.id;
  try {
    const r = await fetch("https://soundcloud.com/", { headers: { "user-agent": UA } });
    if (!r.ok) return null;
    const html = await r.text();
    const assets = [...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"']+\.js/g)].map((m) => m[0]).slice(-4);
    for (const a of assets) {
      const j = await fetch(a, { headers: { "user-agent": UA } });
      if (!j.ok) continue;
      const js = await j.text();
      const m = js.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{28,36})"/);
      if (m) {
        scIdCache = { id: m[1], at: Date.now() };
        return m[1];
      }
    }
  } catch { /* network hiccup — retry next call */ }
  return null;
}

async function scSearch(q: string): Promise<MusicItem[]> {
  const id = await soundcloudClientId();
  if (!id) return [];
  const j = await jget(`https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&limit=24&client_id=${id}`, 7000);
  const out: MusicItem[] = [];
  for (const t of ((j?.collection ?? []) as any[])) {
    if (t?.kind !== "track" || !t?.streamable || t?.policy === "SNIPPET" || Number(t?.duration) <= 90_000) continue;
    const tr = (t?.media?.transcodings ?? []) as any[];
    // prefer progressive (plain mp3); fall back to hls (licensed full tracks —
    // the client plays m3u8 through hls.js)
    const prog = tr.find((x) => x?.format?.protocol === "progressive" && x?.url)?.url ?? null;
    const hls = tr.find((x) => x?.format?.protocol === "hls" && x?.url)?.url ?? null;
    const hint = prog ?? hls;
    if (!hint) continue;
    out.push({
      id: `sc_${t.id}`,
      title: String(t.title ?? ""),
      author: String(t.user?.username ?? ""),
      duration: Math.round((Number(t.duration) || 0) / 1000),
      art: String(t.artwork_url ?? "").replace("-large", "-t500x500"),
      hint: String(hint),
    });
  }
  return out;
}

/** resolve a SoundCloud media transcodings URL into a playable stream URL */
async function resolveScHint(hint: string): Promise<string | null> {
  const id = await soundcloudClientId();
  if (!id) return null;
  const sep = hint.includes("?") ? "&" : "?";
  const r = await jget(`${hint}${sep}client_id=${id}`, 7000);
  const url = r?.url ? String(r.url) : null;
  if (!url) return null;
  if (url.includes("m3u8")) return url; // playlist for hls.js — no audio HEAD
  if (await audioOk(url)) return url;
  return null;
}

async function scStream(scNumericId: string): Promise<string | null> {
  const id = await soundcloudClientId();
  if (!id) return null;
  const t = await jget(`https://api-v2.soundcloud.com/tracks/${scNumericId}?client_id=${id}`, 7000);
  const tr = (t?.media?.transcodings ?? []) as any[];
  const prog = tr.find((x) => x?.format?.protocol === "progressive" && x?.url)?.url ?? null;
  if (prog && (await resolveScHint(String(prog)))) return resolveScHint(String(prog));
  const hls = tr.find((x) => x?.format?.protocol === "hls" && x?.url)?.url ?? null;
  if (hls) return resolveScHint(String(hls));
  return null;
}

/** temporary diagnostics for the SoundCloud resolver (deployed once, then removed) */
export async function scDebug(scNumericId: string) {
  const id = await soundcloudClientId();
  const r = await fetch(`https://api-v2.soundcloud.com/tracks/${scNumericId}?client_id=${id}`, { headers: { "user-agent": UA } });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  const tr = (j?.media?.transcodings ?? []) as any[];
  return {
    clientId: id ? `${id.slice(0, 6)}…(${id.length})` : null,
    status: r.status,
    contentType: r.headers.get("content-type"),
    bodyHead: text.slice(0, 120),
    gotTrack: !!j,
    policy: j?.policy ?? null,
    transcodings: tr.map((x) => x?.format?.protocol),
  };
}

export async function musicSearch(q: string): Promise<MusicItem[]> {
  const piped = PIPED_HOSTS.map(async (h) => {
    const j = await jget(`${h}/search?q=${encodeURIComponent(q)}&filter=music_songs`);
    const items = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
    const out: MusicItem[] = items
      .filter((x: any) => typeof x?.url === "string" && x.url.includes("watch?v="))
      .map((x: any) => ({
        id: String(x.url).split("watch?v=")[1]?.split("&")[0] ?? "",
        title: String(x.title ?? ""),
        author: String(x.uploaderName ?? x.author ?? ""),
        duration: Number(x.duration) || 0,
        art: String(x.thumbnail ?? ""),
      }))
      .filter((x: MusicItem) => x.id && x.title);
    if (!out.length) throw new Error("empty");
    return out;
  });
  const inv = INV_HOSTS.map(async (h) => {
    const j = await jget(`${h}/api/v1/search?q=${encodeURIComponent(q)}&type=video`);
    const out: MusicItem[] = (Array.isArray(j) ? j : [])
      .map((x: any) => ({
        id: String(x?.videoId ?? ""),
        title: String(x?.title ?? ""),
        author: String(x?.author ?? ""),
        duration: Number(x?.lengthSeconds) || 0,
        art: String(x?.videoThumbnails?.[1]?.url ?? x?.videoThumbnails?.[0]?.url ?? ""),
      }))
      .filter((x: MusicItem) => x.id && x.title);
    if (!out.length) throw new Error("empty");
    return out;
  });
  // SoundCloud runs alongside the YouTube-mirror race — its full-length,
  // streamable catalog is a real (if smaller) mainstream source
  const [raced, sc] = await Promise.all([
    firstOk<MusicItem[]>([...piped, ...inv]),
    scSearch(q),
  ]);
  const seen = new Set<string>();
  const merged: MusicItem[] = [];
  for (const item of [...(raced ?? []), ...sc]) {
    const key = `${item.title.toLowerCase()}|${item.author.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

/** HEAD-check that a URL actually serves AUDIO (rejects HTML error/consent pages) */
async function audioOk(url: string): Promise<boolean> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    const r = await fetch(url, { method: "HEAD", redirect: "follow", headers: { "user-agent": UA } });
    clearTimeout(t);
    return r.ok && String(r.headers.get("content-type") ?? "").toLowerCase().startsWith("audio");
  } catch {
    return false;
  }
}

export async function musicStream(id: string, hint?: string | null): Promise<string | null> {
  // SoundCloud full-length tracks (sc_ prefix): resolve the transcodings hint
  // that came with the search row (stateless — /tracks/{id} is datacenter-blocked)
  if (id.startsWith("sc_")) {
    if (hint && /^https:\/\/api-v2\.soundcloud\.com\/media\/upload\/[A-Za-z0-9/_-]+$/.test(hint)) {
      return resolveScHint(hint);
    }
    return scStream(id.slice(3));
  }
  // YouTube's own player API with three clients raced — cheap POSTs (~1-2s).
  // Piped/Invidious stream extraction is REMOVED here: verified dead from
  // Vercel egress (13+10 hosts), they only added 9s of latency before the
  // honest failure. ANDROID URLs are historically non-IP-locked.
  const tube = ["ANDROID", "IOS", "TV"].map(async (clientName) => {
    const r = await fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip" },
      body: JSON.stringify({
        videoId: id,
        contentCheckOk: true,
        racyCheckOk: true,
        context: { client: { clientName, clientVersion: "19.09.37", androidSdkVersion: 30, hl: "en", gl: "US" } },
      }),
    });
    if (!r.ok) throw new Error("player fail");
    const j = await r.json();
    const f = (j?.streamingData?.adaptiveFormats ?? []) as any[];
    const aud = f.filter((x) => x?.url && String(x.mimeType ?? "").startsWith("audio/"));
    aud.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
    const url = aud[0]?.url ?? null;
    if (!url) throw new Error("no formats");
    if (!(await audioOk(url))) throw new Error("not audio");
    return url;
  });
  return firstOk<string>(tube);
}
