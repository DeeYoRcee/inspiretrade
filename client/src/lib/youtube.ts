/**
 * YouTube Music catalog search — the FULL WORLD catalog (every mainstream
 * song), no login, no API key, fully client-side. Search metadata comes from
 * open Piped instances (multi-host fallback); playback runs through the
 * OFFICIAL YouTube IFrame player (compliant, full-length, free).
 */
const PIPED_HOSTS = [
  "https://api.piped.private.coffee",
  "https://pipedapi.drgns.space",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.kavin.rocks",
];

export interface YtTrack {
  videoId: string;
  title: string;
  artist: string;
  duration: number;
  thumb: string;
}

async function fetchJson(url: string, timeoutMs = 6000): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Search the full world catalog; empty array when every host is down. */
export async function ytSearch(q: string): Promise<YtTrack[]> {
  for (const base of PIPED_HOSTS) {
    const j = await fetchJson(`${base}/search?q=${encodeURIComponent(q)}&filter=music_songs`);
    const seen = new Set<string>();
    const list: YtTrack[] = (j?.items ?? [])
      .filter((it: any) => it?.type === "stream" && typeof it?.url === "string" && it.url.includes("v="))
      .map((it: any) => {
        const videoId = new URLSearchParams(it.url.split("?")[1] ?? "").get("v") ?? "";
        return {
          videoId,
          title: it.title ?? "",
          artist: it.uploaderName ?? "YouTube Music",
          duration: Number(it.duration) || 0,
          thumb: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "",
        };
      })
      // dedupe by videoId — duplicate React keys would make row clicks fire
      // the WRONG row's handler (a real "clicked A, B played" bug)
      .filter((t: YtTrack) => {
        if (!t.videoId || seen.has(t.videoId)) return false;
        seen.add(t.videoId);
        return true;
      });
    if (list.length) return list;
  }
  return [];
}

/**
 * THE GUARANTEED PLAYBACK PATH — proxied AUDIO stream for a video via the
 * open Piped `streams` endpoint. This bypasses YouTube's embed-blocking
 * entirely (UMG-blocked songs included): the browser plays the audio bytes
 * directly, no iframe, no embed permission needed. Returns the
 * highest-bitrate audio URL or null when every host fails.
 */
export async function ytAudioStream(videoId: string): Promise<{ url: string; duration: number } | null> {
  for (const base of PIPED_HOSTS) {
    const j = await fetchJson(`${base}/streams/${encodeURIComponent(videoId)}`, 8000);
    const best = (j?.audioStreams ?? [])
      .filter((s: any) => s && typeof s.url === "string")
      .sort((a: any, b: any) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];
    if (best?.url) return { url: String(best.url), duration: Number(j?.duration) || 0 };
  }
  return null;
}

/** Official IFrame API loader (script tag + ready promise, loaded once). */
let apiPromise: Promise<void> | null = null;
export function loadYtIframeApi(): Promise<void> {
  if ((window as any).YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    (window as any).onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    document.head.appendChild(s);
  });
  return apiPromise;
}
