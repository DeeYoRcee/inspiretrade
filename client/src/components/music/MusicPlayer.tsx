/**
 * MusicPlayer — site-wide floating music widget (top-left, under the navbar).
 *
 * Windows-11-Media-Player style: big cover art, seek bar with times,
 * shuffle/repeat, volume, queue. Full-length songs stream FREE from Audius
 * (decentralized music platform, public API, no key — CORS verified). When
 * Audius has few results, the iTunes Search API (JSONP, no key) adds 30s
 * previews. Nothing touches the Vercel serverless budget.
 *
 * Three sizes, persisted in localStorage:
 *   bar  — full player (~320px)
 *   mini — "10%" strip: title + transport (~210px)
 *   dot  — "1%" dot: a single 30px round button, barely there
 */
import { useEffect, useRef, useState } from "react";
import {
  Music, Play, Pause, SkipBack, SkipForward, Search, X, Volume2,
  ChevronDown, Repeat, Repeat1, Shuffle, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Track {
  id: string;
  title: string;
  artist: string;
  art: string;
  url: string;
  duration: number;
  source: "audius" | "itunes";
}

type View = "bar" | "mini" | "dot";
type RepeatMode = "off" | "all" | "one";

interface Persisted {
  view: View;
  volume: number;
}

const STORE_KEY = "inspire_music";

function loadPrefs(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return {
      view: raw.view === "mini" || raw.view === "dot" || raw.view === "bar" ? raw.view : "dot",
      volume: typeof raw.volume === "number" ? raw.volume : 0.8,
    };
  } catch {
    return { view: "dot", volume: 0.8 };
  }
}

const fmt = (sec: number) => {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

/** Full-length tracks from Audius (public discovery nodes, CORS: *). */
async function audiusSearch(q: string): Promise<Track[]> {
  const hosts = [
    "https://api.audius.co",
    "https://discoveryprovider.audius.co",
    "https://discoveryprovider2.audius.co",
    "https://discoveryprovider3.audius.co",
  ];
  for (const host of hosts) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(`${host}/v1/tracks/search?query=${encodeURIComponent(q)}&app_name=InspireTrade`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      const list: Track[] = (json?.data ?? [])
        .filter((t: any) => t?.id && t.title && t.is_original_available !== false)
        .map((t: any) => ({
          id: `a_${t.id}`,
          title: t.title,
          artist: t.user?.name ?? "Audius",
          art: t.artwork?.["480x480"] ?? t.artwork?.["150x150"] ?? "",
          url: `${host}/v1/tracks/${t.id}/stream?app_name=InspireTrade`,
          duration: Number(t.duration) || 0,
          source: "audius" as const,
        }));
      if (list.length) return list;
    } catch { /* try the next discovery node */ }
  }
  return [];
}

/** 30-second previews from the iTunes Search API via JSONP (no CORS headers). */
function itunesSearch(q: string): Promise<Track[]> {
  return new Promise((resolve) => {
    const cb = `itcb_${Math.random().toString(36).slice(2)}`;
    const s = document.createElement("script");
    const done = (list: Track[]) => { clearTimeout(timer); delete (window as any)[cb]; s.remove(); resolve(list); };
    const timer = setTimeout(() => done([]), 9000);
    (window as any)[cb] = (data: any) => {
      done(
        (data?.results || [])
          .filter((r: any) => r.previewUrl)
          .map((r: any) => ({
            id: `i_${r.trackId}`,
            title: r.trackName,
            artist: r.artistName,
            art: (r.artworkUrl100 || "").replace("100x100", "200x200"),
            url: r.previewUrl,
            duration: 30,
            source: "itunes" as const,
          })),
      );
    };
    s.src = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&limit=25&callback=${cb}`;
    s.onerror = () => done([]);
    document.body.appendChild(s);
  });
}

export function MusicPlayer() {
  const [prefs, setPrefs] = useState<Persisted>(loadPrefs);
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [searching, setSearching] = useState(false);
  const [queue, setQueue] = useState<Track[]>([]);
  const [idx, setIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const audioRef = useRef<HTMLAudioElement>(null);

  const view = prefs.view;
  const setView = (v: View) => setPrefs((p) => ({ ...p, view: v }));
  const track = idx >= 0 && idx < queue.length ? queue[idx] : null;

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }, [prefs]);

  const playIndex = (i: number) => {
    const el = audioRef.current;
    if (!el) return;
    if (i < 0 || i >= queue.length) { el.pause(); return; }
    setIdx(i);
    setCur(0);
    setDur(queue[i].duration || 0);
    el.src = queue[i].url;
    el.play().catch(() => setPlaying(false));
  };

  /** next track index — respects shuffle + repeat, wraps on "all" */
  const nextIndex = (from: number, auto: boolean): number => {
    const n = queue.length;
    if (n === 0) return -1;
    if (auto && repeat === "one") return from;
    if (shuffle) return Math.floor(Math.random() * n);
    if (from + 1 < n) return from + 1;
    return auto && repeat === "all" ? 0 : -1;
  };

  // audio element wiring (single persistent element)
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.volume = prefs.volume;
    const onTime = () => setCur(el.currentTime);
    const onMeta = () => setDur(el.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnd = () => {
      const i = nextIndex(idx, true);
      if (i >= 0) {
        if (i === idx) { el.currentTime = 0; el.play().catch(() => {}); }
        else playIndex(i);
      }
    };
    const onError = () => {
      // broken stream (Audius node hiccup) — skip forward, never hang
      const i = nextIndex(idx, false);
      if (i >= 0 && i !== idx) playIndex(i);
      else setPlaying(false);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("ended", onEnd);
    el.addEventListener("error", onError);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("ended", onEnd);
      el.removeEventListener("error", onError);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, prefs.volume, shuffle, repeat, queue]);

  const search = async () => {
    const q = term.trim();
    if (!q) return;
    setSearching(true);
    try {
      const aud = await audiusSearch(q);
      const list = aud.length >= 3 ? aud : [...aud, ...(await itunesSearch(q))];
      setResults(list);
      if (list.length > 0) { setQueue(list); setIdx(-1); playIndex(0); setView("bar"); }
    } finally {
      setSearching(false);
    }
  };

  const toggle = () => {
    const el = audioRef.current;
    if (!el || !track) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };

  const seek = (frac: number) => {
    const el = audioRef.current;
    if (el && dur > 0) el.currentTime = frac * dur;
  };

  const seekFrac = dur > 0 ? cur / dur : 0;

  const trackRow = (t: Track, i: number) => (
    <button
      key={t.id}
      onClick={() => { setQueue(results); playIndex(i); }}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-white/5",
        i === idx && "bg-emerald-500/10",
      )}
    >
      {t.art ? (
        <img src={t.art} alt="" className="h-8 w-8 rounded-md object-cover" loading="lazy" />
      ) : (
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-white/5"><Music className="h-3.5 w-3.5 text-muted-foreground" /></span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-semibold text-foreground">{t.title}</span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {t.artist}{t.source === "itunes" ? " · preview" : ""} {t.duration ? `· ${fmt(t.duration)}` : ""}
        </span>
      </span>
      {i === idx && playing && <Pause className="h-3 w-3 shrink-0 text-emerald-400" />}
    </button>
  );

  // ---------- dot (1%) ----------
  if (view === "dot") {
    return (
      <>
        <audio ref={audioRef} className="hidden" />
        <div className="fixed left-2 top-[7rem] z-40 sm:left-3 sm:top-[4.25rem]">
          <button
            onClick={() => setView("bar")}
            className="relative flex h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-[#0d1117]/90 shadow-lg backdrop-blur transition-colors hover:border-emerald-500/50"
            title="Music player"
          >
            <Music className="h-4 w-4 text-emerald-400" />
            {playing && <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400" />}
          </button>
        </div>
      </>
    );
  }

  const wide = view === "bar";

  // ---------- bar (full, W11 style) / mini (10%) ----------
  return (
    <>
      <audio ref={audioRef} className="hidden" />
      <div className={cn("fixed left-2 top-[7rem] z-40 sm:left-3 sm:top-[4.25rem]", wide ? "w-80" : "w-56")}>
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#101418]/95 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.8)] backdrop-blur-xl">
          {/* header: search (bar) / title (mini) + view switches */}
          <div className="flex items-center gap-1.5 px-2.5 py-2">
            <Music className="h-4 w-4 shrink-0 text-emerald-400" />
            {wide ? (
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") search(); }}
                  placeholder="Search full songs…"
                  className="h-7 w-full rounded-lg border border-white/10 bg-white/5 pl-7 pr-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:border-emerald-500/50"
                />
                {searching && <Loader2 className="absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin text-muted-foreground" />}
              </div>
            ) : (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-semibold text-foreground">{track?.title ?? "Music"}</span>
                <span className="block truncate text-[10px] text-muted-foreground">{track?.artist ?? ""}</span>
              </span>
            )}
            <button onClick={() => setView(wide ? "mini" : "bar")} className="shrink-0 text-muted-foreground hover:text-foreground" title={wide ? "Minimize" : "Expand"}>
              {wide ? <ChevronDown className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            </button>
            <button onClick={() => setView("dot")} className="shrink-0 text-muted-foreground hover:text-foreground" title="Hide (keep playing)">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* now playing — cover art + info (bar only) */}
          {wide && track && (
            <div className="flex items-center gap-3 px-3 pb-2">
              {track.art ? (
                <img src={track.art} alt="" className="h-20 w-20 rounded-xl object-cover shadow-lg" />
              ) : (
                <div className="flex h-20 w-20 items-center justify-center rounded-xl bg-white/5">
                  <Music className="h-8 w-8 text-muted-foreground" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-foreground">{track.title}</p>
                <p className="truncate text-xs text-muted-foreground">{track.artist}</p>
                <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-emerald-400/80">
                  {track.source === "audius" ? "Full track · Audius" : "30s preview · iTunes"}
                </p>
              </div>
            </div>
          )}

          {/* transport + seek */}
          {track && (
            <div className="px-3 pb-2.5">
              {/* seek bar */}
              <input
                type="range" min={0} max={1000} step={1} value={Math.round(seekFrac * 1000)}
                onChange={(e) => seek(Number(e.target.value) / 1000)}
                className="h-1 w-full cursor-pointer accent-emerald-400"
                title="Seek"
              />
              <div className="mb-1.5 flex justify-between text-[10px] tabular-nums text-muted-foreground">
                <span>{fmt(cur)}</span>
                <span>{fmt(dur)}</span>
              </div>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => setShuffle((v) => !v)}
                  className={cn("rounded-lg p-1.5", shuffle ? "text-emerald-400" : "text-muted-foreground hover:text-foreground")}
                  title="Shuffle"
                >
                  <Shuffle className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => playIndex(idx - 1)} className="text-foreground/80 hover:text-foreground" title="Previous">
                  <SkipBack className="h-4 w-4" />
                </button>
                <button
                  onClick={toggle}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500 text-black shadow-lg transition-transform hover:scale-105"
                  title={playing ? "Pause" : "Play"}
                >
                  {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </button>
                <button onClick={() => playIndex(idx + 1)} className="text-foreground/80 hover:text-foreground" title="Next">
                  <SkipForward className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off"))}
                  className={cn("rounded-lg p-1.5", repeat !== "off" ? "text-emerald-400" : "text-muted-foreground hover:text-foreground")}
                  title={`Repeat: ${repeat}`}
                >
                  {repeat === "one" ? <Repeat1 className="h-3.5 w-3.5" /> : <Repeat className="h-3.5 w-3.5" />}
                </button>
              </div>
              {/* volume */}
              <div className="mt-2 flex items-center gap-1.5">
                <Volume2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  type="range" min={0} max={1} step={0.05} value={prefs.volume}
                  onChange={(e) => setPrefs((p) => ({ ...p, volume: Number(e.target.value) }))}
                  className="h-1 flex-1 cursor-pointer accent-emerald-400"
                  title="Volume"
                />
              </div>
            </div>
          )}

          {/* queue / search results */}
          {wide && (
            <div className="max-h-52 overflow-y-auto border-t border-white/10 px-2 py-1.5">
              {searching && <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching Audius…</div>}
              {!searching && !results.length && (
                <div className="py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
                  Search any song, press Enter.<br />Full-length free tracks from Audius,<br />30s previews from iTunes.
                </div>
              )}
              {results.map(trackRow)}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
