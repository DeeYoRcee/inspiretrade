/**
 * MusicPlayer — site-wide floating music widget (top-left, under the navbar).
 *
 * Lets every visitor search and listen to the songs THEY want. Source: the
 * free iTunes Search API via JSONP (no API key, no backend, CORS-free) —
 * 30-second previews streamed straight from Apple's CDN through a single
 * HTMLAudioElement. Nothing touches the Vercel serverless budget.
 *
 * Three sizes, persisted in localStorage:
 *   bar  — full panel: search + results + now-playing controls (~300px)
 *   mini — "10%" strip: title + transport controls (~190px)
 *   dot  — "1%" dot: a single 30px round button, barely there
 */
import { useEffect, useRef, useState } from "react";
import { Music, Play, Pause, SkipBack, SkipForward, Search, X, Volume2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface Track {
  id: number;
  title: string;
  artist: string;
  art: string;
  url: string;
}

type View = "bar" | "mini" | "dot";

interface Persisted {
  view: View;
  volume: number;
}

const STORE_KEY = "inspire_music";

function loadPrefs(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return { view: raw.view === "mini" || raw.view === "dot" || raw.view === "bar" ? raw.view : "dot", volume: typeof raw.volume === "number" ? raw.volume : 0.8 };
  } catch {
    return { view: "dot", volume: 0.8 };
  }
}

/** iTunes Search API via JSONP (no CORS headers on that endpoint). */
function itunesSearch(term: string): Promise<Track[]> {
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
            id: r.trackId,
            title: r.trackName,
            artist: r.artistName,
            art: (r.artworkUrl100 || "").replace("100x100", "200x200"),
            url: r.previewUrl,
          })),
      );
    };
    s.src = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&limit=25&callback=${cb}`;
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
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  const view = prefs.view;
  const setView = (v: View) => setPrefs((p) => ({ ...p, view: v }));
  const track = idx >= 0 && idx < queue.length ? queue[idx] : null;

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }, [prefs]);

  // audio element wiring
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.volume = prefs.volume;
    const onTime = () => setProgress(el.duration ? el.currentTime / el.duration : 0);
    const onEnd = () => playIndex(idx + 1);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnd);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("ended", onEnd);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, prefs.volume]);

  const playIndex = (i: number) => {
    const el = audioRef.current;
    if (!el) return;
    if (i < 0 || i >= queue.length) { el.pause(); return; }
    setIdx(i);
    el.src = queue[i].url;
    el.play().catch(() => setPlaying(false));
  };

  const search = async () => {
    const q = term.trim();
    if (!q) return;
    setSearching(true);
    const list = await itunesSearch(q);
    setResults(list);
    if (list.length > 0) { setQueue(list); playIndex(0); setView("mini"); }
    setSearching(false);
  };

  const toggle = () => {
    const el = audioRef.current;
    if (!el || !track) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };

  if (view === "dot") {
    return (
      <>
        {/* single persistent audio element — survives view switches */}
        <audio ref={audioRef} className="hidden" />
        <div className="fixed left-2 top-[7rem] z-40 sm:left-3 sm:top-[4.25rem]">
          <button
            onClick={() => setView("bar")}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-[#0d1117]/90 shadow-lg backdrop-blur hover:border-emerald-500/50"
            title="Music player"
          >
            <Music className="h-3.5 w-3.5 text-emerald-400" />
            {playing && <span className="absolute -top-0.5 -right-0.5 h-2 w-2 animate-pulse rounded-full bg-emerald-400" />}
          </button>
        </div>
      </>
    );
  }

  const wide = view === "bar";

  return (
    <>
      <audio ref={audioRef} className="hidden" />
      <div className={cn("fixed left-2 top-[7rem] z-40 sm:left-3 sm:top-[4.25rem]", wide ? "w-72" : "w-48")}>
      <div className="overflow-hidden rounded-xl border border-border/60 bg-[#0d1117]/95 shadow-2xl backdrop-blur">
        {/* header */}
        <div className="flex items-center gap-1.5 border-b border-border/50 px-2 py-1.5">
          <Music className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
          {wide ? (
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") search(); }}
              placeholder="Search songs, artists…"
              className="h-6 min-w-0 flex-1 rounded-md border border-border/50 bg-transparent px-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:border-emerald-500/40"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground">
              {track ? `${track.title} — ${track.artist}` : "Music"}
            </span>
          )}
          <button onClick={() => setView(wide ? "mini" : "bar")} className="text-muted-foreground hover:text-foreground" title={wide ? "Minimize" : "Expand"}>
            {wide ? <ChevronDown className="h-3.5 w-3.5" /> : <Search className="h-3.5 w-3.5" />}
          </button>
          <button onClick={() => setView("dot")} className="text-muted-foreground hover:text-foreground" title="Hide (keep playing)">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* expanded: search results */}
        {wide && (
          <div className="max-h-56 overflow-y-auto px-1.5 py-1.5">
            {searching && <div className="py-3 text-center text-[11px] text-muted-foreground">Searching…</div>}
            {!searching && !results.length && (
              <div className="py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
                Search any song — press Enter.<br />30s previews play instantly.
              </div>
            )}
            {results.map((t, i) => (
              <button
                key={t.id}
                onClick={() => { setQueue(results); playIndex(i); }}
                className={cn("flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-card/60", i === idx && "bg-emerald-500/10")}
              >
                {t.art ? <img src={t.art} alt="" className="h-8 w-8 rounded" loading="lazy" /> : <Music className="h-7 w-7 text-muted-foreground" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-semibold text-foreground">{t.title}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{t.artist}</span>
                </span>
                {i === idx && playing && <Pause className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
            ))}
          </div>
        )}

        {/* transport */}
        {track && (
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <button onClick={() => playIndex(idx - 1)} className="text-muted-foreground hover:text-foreground" title="Previous">
              <SkipBack className="h-3.5 w-3.5" />
            </button>
            <button onClick={toggle} className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400" title={playing ? "Pause" : "Play"}>
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>
            <button onClick={() => playIndex(idx + 1)} className="text-muted-foreground hover:text-foreground" title="Next">
              <SkipForward className="h-3.5 w-3.5" />
            </button>
            {/* progress */}
            <div className="mx-1 h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-emerald-400" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <div className="flex items-center gap-1">
              <Volume2 className="h-3 w-3 text-muted-foreground" />
              <input
                type="range" min={0} max={1} step={0.05} value={prefs.volume}
                onChange={(e) => setPrefs((p) => ({ ...p, volume: Number(e.target.value) }))}
                className="h-1 w-12 cursor-pointer accent-emerald-400"
                title="Volume"
              />
            </div>
          </div>
        )}
      </div>
      </div>
    </>
  );
}
