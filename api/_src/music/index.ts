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
];

const INV_HOSTS = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://yewtu.be",
  "https://invidious.private.coffee",
  "https://iv.datura.network",
  "https://invidious.f5.si",
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
  return (await firstOk<MusicItem[]>([...piped, ...inv])) ?? [];
}

export async function musicStream(id: string): Promise<string | null> {
  const piped = PIPED_HOSTS.map(async (h) => {
    const j = await jget(`${h}/streams/${id}`);
    const all = (j?.audioStreams ?? []) as any[];
    const m4a = all.filter((s) => s?.url && String(s.mimeType ?? "").includes("mp4"));
    m4a.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
    const url = m4a[0]?.url ?? all.find((s) => s?.url)?.url ?? null;
    if (!url) throw new Error("no audio");
    return String(url);
  });
  // YouTube's own player API, ANDROID client — sometimes still serves direct
  // (non-IP-locked) audio URLs from datacenter IPs
  const tube = (async () => {
    const r = await fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip" },
      body: JSON.stringify({
        videoId: id,
        contentCheckOk: true,
        racyCheckOk: true,
        context: { client: { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 30, hl: "en", gl: "US" } },
      }),
    });
    if (!r.ok) throw new Error("player fail");
    const j = await r.json();
    const f = (j?.streamingData?.adaptiveFormats ?? []) as any[];
    const aud = f.filter((x) => x?.url && String(x.mimeType ?? "").startsWith("audio/"));
    aud.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
    const url = aud[0]?.url ?? null;
    if (!url) throw new Error("no formats");
    return String(url);
  })();
  // Invidious proxied redirect — latest_version follows to the instance's
  // own proxy, so the URL is NOT locked to the function's IP
  const inv = INV_HOSTS.map(async (h) => {
    const target = `${h}/latest_version?id=${id}&itag=140&local=true`;
    const r = await fetch(target, { method: "HEAD", redirect: "follow", headers: { "user-agent": UA } });
    if (!r.ok) throw new Error("no stream");
    return r.url || target;
  });
  return firstOk<string>([...piped, tube, ...inv]);
}
