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
  return ((j?.collection ?? []) as any[])
    .filter((t) => t?.kind === "track" && t?.streamable && t?.policy !== "SNIPPET" && Number(t?.duration) > 90_000)
    .map((t) => ({
      id: `sc_${t.id}`,
      title: String(t.title ?? ""),
      author: String(t.user?.username ?? ""),
      duration: Math.round((Number(t.duration) || 0) / 1000),
      art: String(t.artwork_url ?? "").replace("-large", "-t500x500"),
    }))
    .filter((x) => x.id.length > 3 && x.title);
}

async function scStream(scNumericId: string): Promise<string | null> {
  const id = await soundcloudClientId();
  if (!id) return null;
  const t = await jget(`https://api-v2.soundcloud.com/tracks/${scNumericId}?client_id=${id}`, 7000);
  const tr = (t?.media?.transcodings ?? []) as any[];
  // progressive = plain mp3 (free/older uploads); hls = licensed full tracks —
  // the client plays those through hls.js, exactly like SoundCloud's own web app
  const prog = tr.find((x) => x?.format?.protocol === "progressive" && x?.url);
  const hls = tr.find((x) => x?.format?.protocol === "hls" && x?.url);
  if (prog) {
    const r = await jget(`${prog.url}${String(prog.url).includes("?") ? "&" : "?"}client_id=${id}`, 7000);
    if (r?.url && (await audioOk(String(r.url)))) return String(r.url);
  }
  if (hls) {
    const r = await jget(`${hls.url}${String(hls.url).includes("?") ? "&" : "?"}client_id=${id}`, 7000);
    if (r?.url && String(r.url).includes("m3u8")) return String(r.url);
  }
  return null;
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

export async function musicStream(id: string): Promise<string | null> {
  // SoundCloud full-length tracks (sc_ prefix) — direct progressive mp3
  if (id.startsWith("sc_")) return scStream(id.slice(3));
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
