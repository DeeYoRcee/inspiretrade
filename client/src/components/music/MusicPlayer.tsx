/**
 * MusicPlayer — site-wide floating music widget. v4.
 *
 * Ground truth from live probing (2026): every YouTube full-track path is
 * closed off — Piped/Invidious proxies are dead and YouTube's own InnerTube
 * player API is PO-token/SABR-gated on ALL clients (10 tried server-side).
 * Apple's public catalog only carries 30s previews. So the player maximizes
 * what actually WORKS, with zero autoplay and zero jargon:
 *
 *   1. Audius (free, decentralized) — FULL-LENGTH tracks, direct stream
 *      URLs, CORS-open. Listed FIRST: whatever the query finds playable in
 *      full comes on top (official artists + remixes/covers).
 *   2. iTunes catalog — the full MAINSTREAM index (every famous artist).
 *      Public API only exposes ~30s previews; those rows show 0:30 and are
 *      listed after the full-length ones. Always playable (Apple CDN).
 *
 * NO AUTO-PLAY: search fills the list only — the user taps the song they
 * want. If a tapped full track fails to load, the player silently retries
 * with the same song's 30s preview rather than staying silent.
 *
 * The panel is fully theme-aware (bg-card / border / muted tokens).
 * Sizes, persisted in localStorage: bar / mini / dot.
 */
import { useEffect, useRef, useState } from "react";
import {
  Music, Play, Pause, SkipBack, SkipForward, Search, X, Volume2,
  ChevronDown, ChevronUp, Repeat, Repeat1, Shuffle, Loader2, ListMusic,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Track {
  id: string;
  title: string;
  artist: string;
  art: string;
  /** direct, always-playable audio URL */
  url: string;
  duration: number;
}

type View = "bar" | "mini" | "dot";
type RepeatMode = "off" | "all" | "one";

interface Persisted {
  view: View;
  volume: number;
  /** panel transparency, 0.2 (mostly see-through) … 1 (solid) */
  opacity: number;
  /** dragged position (viewport px); null = default top-left spot */
  pos: { x: number; y: number } | null;
}

const STORE_KEY = "inspire_music";

function loadPrefs(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return {
      view: raw.view === "mini" || raw.view === "dot" || raw.view === "bar" ? raw.view : "dot",
      volume: typeof raw.volume === "number" ? raw.volume : 0.8,
      opacity: typeof raw.opacity === "number" ? Math.min(1, Math.max(0.2, raw.opacity)) : 1,
      pos:
        raw.pos && typeof raw.pos.x === "number" && typeof raw.pos.y === "number"
          ? { x: raw.pos.x, y: raw.pos.y }
          : null,
    };
  } catch {
    return { view: "dot", volume: 0.8, opacity: 1, pos: null };
  }
}

const fmt = (sec: number) => {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

/** Full-length free tracks from Audius (public discovery nodes, CORS: *). */
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
      const res = await fetch(`${host}/v1/tracks/search?query=${encodeURIComponent(q)}&limit=40&app_name=InspireTrade`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      const list: Track[] = (json?.data ?? [])
        .filter((t: any) => t?.id && t.title && t.is_original_available !== false && t.duration > 60)
        .map((t: any) => ({
          id: `a_${t.id}`,
          title: t.title,
          artist: t.user?.name ?? "Unknown artist",
          art: t.artwork?.["480x480"] ?? t.artwork?.["150x150"] ?? "",
          url: `${host}/v1/tracks/${t.id}/stream?app_name=InspireTrade`,
          duration: Number(t.duration) || 0,
        }));
      if (list.length) return list;
    } catch { /* try the next discovery node */ }
  }
  return [];
}

/**
 * FULL-LENGTH YouTube catalog through our own serverless resolver
 * (/api/news?music=… — Vercel egress, browser CORS never involved).
 * Rows carry no URL — the stream is resolved at play time; if the resolver
 * fails the same song is retried as a 30s preview (never silence).
 */
async function ytApiSearch(q: string): Promise<Track[]> {
  try {
    const r = await fetch(`/api/news?music=search&q=${encodeURIComponent(q)}`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j?.items ?? [])
      .filter((v: any) => v?.id)
      .slice(0, 30)
      .map((v: any) => ({
        id: String(v.id),
        title: String(v.title ?? ""),
        artist: String(v.author ?? "YouTube"),
        art: String(v.art ?? ""),
        url: "", // resolved at play time via ?music=stream
        duration: Number(v.duration) || 0,
      }));
  } catch {
    return [];
  }
}

/** resolve the playable audio URL for a full-length YouTube track */
async function resolveYtStream(id: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/news?music=stream&id=${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    const j = await r.json();
    return j?.url ? String(j.url) : null;
  } catch {
    return null;
  }
}

/** Mainstream catalog index — iTunes Search API (CORS-open, no key). */
async function itunesSearch(q: string): Promise<Track[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `https://itunes.apple.com/search?media=music&limit=30&term=${encodeURIComponent(q)}`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = await res.json();
    return (json?.results ?? [])
      .filter((r: any) => r?.previewUrl && r?.trackName)
      .map((r: any) => ({
        id: `i_${r.trackId}`,
        title: String(r.trackName),
        artist: String(r.artistName ?? "Unknown artist"),
        art: String(r.artworkUrl100 ?? "").replace("100x100", "300x300"),
        url: String(r.previewUrl),
        duration: 30, // Apple previews are ~30s — honest value for the row
      }));
  } catch {
    return [];
  }
}

export function MusicPlayer() {
  const [prefs, setPrefs] = useState<Persisted>(loadPrefs);
  const [term, setTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [queue, setQueue] = useState<Track[]>([]);
  const [idx, setIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [note, setNote] = useState<string | null>(null);
  // song list: auto-hidden WHILE a track plays, auto-returns on pause —
  // the header List button / the X inside the list override it manually
  const [showList, setShowList] = useState(true);
  useEffect(() => { setShowList(!playing); }, [playing]);

  const audioRef = useRef<HTMLAudioElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; w: number; h: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const queueRef = useRef<Track[]>(queue);
  const idxRef = useRef<number>(idx);
  const repeatRef = useRef<RepeatMode>(repeat);
  const shuffleRef = useRef<boolean>(shuffle);
  // consecutive load failures — stop the auto-skip chain after too many
  const failRef = useRef(0);
  // track ids already retried as a 30s preview (avoid loops)
  const previewTriedRef = useRef<Set<string>>(new Set());
  queueRef.current = queue;
  idxRef.current = idx;
  repeatRef.current = repeat;
  shuffleRef.current = shuffle;

  const view = prefs.view;
  const setView = (v: View) => setPrefs((p) => ({ ...p, view: v }));
  const track = idx >= 0 && idx < queue.length ? queue[idx] : null;

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }, [prefs]);

  // ---- drag-to-move (pointer events, viewport-clamped, persisted) ----
  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const r = (e.currentTarget as HTMLElement).closest("[data-music-panel]")?.getBoundingClientRect();
    if (!r) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, w: r.width, h: r.height, moved: false };
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
      if (!d.moved) return;
      const x = Math.min(window.innerWidth - d.w - 4, Math.max(4, d.ox + dx));
      const y = Math.min(window.innerHeight - d.h - 4, Math.max(8, d.oy + dy));
      // 8px grid snap — the widget moves in precise steps, never drifts
      let sx = Math.round(x / 8) * 8;
      const sy = Math.round(y / 8) * 8;
      // edge docking — near the left/right border it snaps flush and STAYS
      // reachable
      if (sx <= 24) sx = 4;
      if (window.innerWidth - (sx + d.w) <= 24) sx = Math.max(4, window.innerWidth - d.w - 4);
      setPrefs((p) => ({ ...p, pos: { x: sx, y: sy } }));
    };
    const onUp = () => {
      if (dragRef.current?.moved) suppressClick.current = true;
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  // keep the widget reachable: clamp the saved position into the viewport on
  // load and on every window resize
  useEffect(() => {
    const clamp = () => {
      setPrefs((p) => {
        if (!p.pos) return p;
        const x = Math.min(window.innerWidth - 38, Math.max(4, p.pos.x));
        const y = Math.min(window.innerHeight - 38, Math.max(8, p.pos.y));
        return x === p.pos.x && y === p.pos.y ? p : { ...p, pos: { x, y } };
      });
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  // ---- playback core: one audio element, direct URLs only ----------------

  /** next index honouring repeat / shuffle; -1 = stop */
  const nextIndex = (from: number, natural: boolean): number => {
    const q = queueRef.current;
    if (q.length === 0) return -1;
    if (repeatRef.current === "one" && natural) return from;
    if (shuffleRef.current && q.length > 1) {
      let j = from;
      while (j === from) j = Math.floor(Math.random() * q.length);
      return j;
    }
    const j = from + 1;
    if (j >= q.length) return repeatRef.current !== "off" ? 0 : -1;
    return j;
  };

  /** 30s-preview rescue for a track whose full version failed to load */
  const playPreviewFor = async (t: Track): Promise<boolean> => {
    if (previewTriedRef.current.has(t.id)) return false;
    previewTriedRef.current.add(t.id);
    const hits = await itunesSearch(`${t.title} ${t.artist}`.slice(0, 90));
    const hit = hits[0];
    const el = audioRef.current;
    if (!hit?.url || !el) return false;
    el.src = hit.url;
    el.play().catch(() => setPlaying(false));
    setNote("Full version didn't load — playing a short preview");
    return true;
  };

  const playIndex = (i: number, list?: Track[]) => {
    if (list) queueRef.current = list;
    const q = queueRef.current;
    if (i < 0 || i >= q.length) return;
    const t = q[i];
    setIdx(i);
    setCur(0);
    setDur(t.duration || 0);
    setNote(null);
    const el = audioRef.current;
    if (!el) return;
    try { el.pause(); } catch { /* ignore */ }
    setLoading(true);
    if (t.url) {
      // direct URL (Audius / iTunes preview) — play immediately
      el.src = t.url;
      el.play().catch(() => setPlaying(false));
    } else {
      // full-length YouTube track — resolve the stream server-side first
      void resolveYtStream(t.id).then((url) => {
        if (idxRef.current !== i) return; // the user picked another song meanwhile
        if (url) {
          el.src = url;
          el.play().catch(() => setPlaying(false));
        } else {
          void playPreviewFor(t).then((ok) => {
            if (ok) return;
            setLoading(false);
            setNote("Couldn't load that song — try another one");
          });
        }
      });
    }
  };

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCur(el.currentTime);
    const onMeta = () => {
      const t = queueRef.current[idxRef.current];
      setDur(el.duration && Number.isFinite(el.duration) ? el.duration : t?.duration || 0);
    };
    const onPlay = () => { setPlaying(true); failRef.current = 0; };
    const onPause = () => setPlaying(false);
    const onWait = () => setLoading(true);
    const onCan = () => setLoading(false);
    const onEnd = () => {
      const i = nextIndex(idxRef.current, true);
      if (i === idxRef.current) { el.currentTime = 0; el.play().catch(() => {}); }
      else if (i >= 0) playIndex(i);
      else setPlaying(false);
    };
    const onError = () => {
      const t = queueRef.current[idxRef.current];
      if (!t) return;
      // first line of defense: the same song as a short preview (async,
      // fire-and-forget — the audio element may keep firing events meanwhile)
      void playPreviewFor(t).then((ok) => {
        if (ok) return;
        const i = nextIndex(idxRef.current, false);
        if (i >= 0 && i !== idxRef.current && failRef.current < 3) {
          failRef.current += 1;
          setNote("That one didn't load — skipped to the next song");
          playIndex(i);
        } else {
          setPlaying(false);
          setLoading(false);
          setNote("Couldn't load that song — try another one");
        }
      });
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("waiting", onWait);
    el.addEventListener("playing", onCan);
    el.addEventListener("canplay", onCan);
    el.addEventListener("ended", onEnd);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("waiting", onWait);
      el.removeEventListener("playing", onCan);
      el.removeEventListener("canplay", onCan);
      el.removeEventListener("ended", onEnd);
      el.removeEventListener("error", onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // volume follows the slider without re-subscribing the audio events
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = prefs.volume;
  }, [prefs.volume]);

  const search = async () => {
    const q = term.trim();
    if (!q) return;
    setSearching(true);
    setNote(null);
    failRef.current = 0;
    previewTriedRef.current = new Set();
    try {
      // full-length sources first: our serverless YouTube resolver, then
      // Audius — the mainstream index ALWAYS follows so the exact song is
      // in the list (0:30 preview rows). NO autoplay: the user picks.
      const [yt, au0, it] = await Promise.all([ytApiSearch(q), audiusSearch(q), itunesSearch(q)]);
      let au = au0;
      if (au.length < 3) {
        // broader second look for remix/cover coverage
        const short = q.split(/\s+/).slice(0, 3).join(" ");
        if (short && short !== q) {
          const extra = await audiusSearch(short);
          au = [...au, ...extra.filter((x) => !au.some((y) => y.id === x.id))];
        }
      }
      const seen = new Set<string>();
      const list = [...yt, ...au, ...it].filter((t) => {
        const k = `${t.title}|${t.artist}`.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (list.length) {
        setQueue(list);
        setIdx(-1);
        setPlaying(false);
        try { audioRef.current?.pause(); } catch { /* ignore */ }
      } else {
        setNote("Nothing found — try another spelling");
      }
    } finally {
      setSearching(false);
    }
  };

  /** snap the widget flush to the top / bottom edge of the screen (x kept) */
  const snapV = (to: "top" | "bottom") => {
    const r = (document.querySelector("[data-music-panel]") as HTMLElement | null)?.getBoundingClientRect();
    if (!r) return;
    const y = to === "top" ? 8 : Math.max(8, window.innerHeight - r.height - 8);
    const x = Math.min(Math.max(4, r.left), Math.max(4, window.innerWidth - r.width - 4));
    setPrefs((p) => ({ ...p, pos: { x, y } }));
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

  const skip = (dir: 1 | -1) => {
    const i = dir === 1 ? nextIndex(idx, false) : idx + dir < 0 ? queue.length - 1 : idx + dir;
    if (i >= 0) playIndex(i);
  };

  const wide = view === "bar";
  const seekFrac = dur > 0 ? cur / dur : 0;

  const trackRow = (t: Track, i: number) => (
    <button
      key={t.id}
      onClick={() => playIndex(i, queue)}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-muted/60",
        i === idx && "bg-primary/10",
      )}
    >
      {t.art ? (
        <img src={t.art} alt="" className="h-8 w-8 rounded-md object-cover" loading="lazy" />
      ) : (
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-muted"><Music className="h-3.5 w-3.5 text-muted-foreground" /></span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-semibold text-foreground">{t.title}</span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {t.artist}{t.duration ? ` · ${fmt(t.duration)}` : ""}
        </span>
      </span>
      {i === idx && loading && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />}
    </button>
  );

  return (
    <>
      <audio ref={audioRef} className="hidden" />
      <div
        data-music-panel
        className="fixed left-2 top-[7rem] z-40 sm:left-3 sm:top-[4.25rem]"
        style={prefs.pos ? { left: prefs.pos.x, top: prefs.pos.y } : undefined}
      >
        {/* dot (1%) — only in dot view */}
        <button
          onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } setView("bar"); }}
          onPointerDown={startDrag}
          className={cn(
            "relative h-9 w-9 touch-none items-center justify-center rounded-full border border-border/60 bg-card/90 shadow-lg backdrop-blur transition-colors hover:border-primary/50 active:cursor-grabbing",
            view === "dot" ? "flex" : "hidden",
          )}
          title="Music player — drag to move"
        >
          <Music className="h-4 w-4 text-primary" />
          {playing && <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-primary" />}
        </button>

        {/* card (bar / mini) — hidden in dot view, never unmounted mid-song */}
        <div className={cn(view !== "dot" ? "block" : "hidden", wide ? "w-80" : "w-56")}>
          <div
            className="overflow-hidden rounded-2xl border border-border/60 bg-card/95 shadow-xl backdrop-blur-xl"
            style={{ opacity: prefs.opacity }}
          >
            {/* header: drag handle + search (bar) / title (mini) + view switches */}
            <div className="flex items-center gap-1.5 px-2.5 py-2">
              <div
                onPointerDown={startDrag}
                className="flex h-7 w-7 shrink-0 touch-none cursor-grab items-center justify-center rounded-md text-primary hover:bg-muted active:cursor-grabbing"
                title="Drag to move"
              >
                <Music className="h-4 w-4" />
              </div>
              {wide ? (
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={term}
                    onChange={(e) => setTerm(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") search(); }}
                    placeholder="Song name…"
                    className="h-7 w-full rounded-lg border border-border/60 bg-muted/50 pl-7 pr-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50"
                  />
                  {searching && <Loader2 className="absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin text-muted-foreground" />}
                </div>
              ) : (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-semibold text-foreground">{track?.title ?? "Music"}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{track?.artist ?? ""}</span>
                </span>
              )}
              {wide && (
                <button
                  onClick={() => setShowList((v) => !v)}
                  className={cn("shrink-0 text-muted-foreground hover:text-foreground", showList && "text-primary")}
                  title="Song list — open/close (works while playing)"
                >
                  <ListMusic className="h-4 w-4" />
                </button>
              )}
              {/* vertical pins — snap the floating widget to the top/bottom edge */}
              <button onClick={() => snapV("top")} className="shrink-0 text-muted-foreground hover:text-foreground" title="Pin to top">
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => snapV("bottom")} className="shrink-0 text-muted-foreground hover:text-foreground" title="Pin to bottom">
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => setView(wide ? "mini" : "bar")} className="shrink-0 text-muted-foreground hover:text-foreground" title={wide ? "Minimize" : "Expand"}>
                {wide ? <ChevronDown className="h-4 w-4" /> : <Search className="h-4 w-4" />}
              </button>
              <button onClick={() => setView("dot")} className="shrink-0 text-muted-foreground hover:text-foreground" title="Hide (keep playing)">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* quiet info line — only when something actually needs saying */}
            {wide && note && (
              <div className="mx-3 mb-1.5 rounded-lg border border-border/60 bg-muted/50 px-2 py-1 text-[10px] leading-relaxed text-muted-foreground">
                {note}
              </div>
            )}

            {/* now playing — cover art (bar view) */}
            {wide && track && (
              <div className="flex items-center gap-3 px-3 pb-2">
                {track.art ? (
                  <img src={track.art} alt="" className="h-20 w-20 rounded-xl object-cover shadow-lg" />
                ) : (
                  <div className="flex h-20 w-20 items-center justify-center rounded-xl bg-muted">
                    <Music className="h-8 w-8 text-muted-foreground" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-foreground">{track.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{track.artist}</p>
                  {loading && (
                    <p className="mt-1 flex items-center gap-1 text-[10px] font-medium text-primary">
                      <Loader2 className="h-3 w-3 animate-spin" /> loading…
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* transport + seek */}
            {track && (
              <div className="px-3 pb-2.5">
                <input
                  type="range" min={0} max={1000} step={1} value={Math.round(seekFrac * 1000)}
                  onChange={(e) => seek(Number(e.target.value) / 1000)}
                  className="h-1 w-full cursor-pointer accent-primary"
                  title="Seek"
                />
                <div className="mb-1.5 flex justify-between text-[10px] tabular-nums text-muted-foreground">
                  <span>{fmt(cur)}</span>
                  <span>{fmt(dur)}</span>
                </div>
                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={() => setShuffle((v) => !v)}
                    className={cn("rounded-lg p-1.5", shuffle ? "text-primary" : "text-muted-foreground hover:text-foreground")}
                    title="Shuffle"
                  >
                    <Shuffle className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => skip(-1)} className="text-foreground/80 hover:text-foreground" title="Previous">
                    <SkipBack className="h-4 w-4" />
                  </button>
                  <button
                    onClick={toggle}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105"
                    title={playing ? "Pause" : "Play"}
                  >
                    {loading && !playing ? <Loader2 className="h-4 w-4 animate-spin" /> : playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </button>
                  <button onClick={() => skip(1)} className="text-foreground/80 hover:text-foreground" title="Next">
                    <SkipForward className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off"))}
                    className={cn("rounded-lg p-1.5", repeat !== "off" ? "text-primary" : "text-muted-foreground hover:text-foreground")}
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
                    className="h-1 flex-1 cursor-pointer accent-primary"
                    title="Volume"
                  />
                </div>
                {/* panel transparency — lower % = more see-through */}
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">Transparency</span>
                  <input
                    type="range" min={20} max={100} step={5} value={Math.round(prefs.opacity * 100)}
                    onChange={(e) => setPrefs((p) => ({ ...p, opacity: Number(e.target.value) / 100 }))}
                    className="h-1 flex-1 cursor-pointer accent-primary"
                    title="Panel transparency"
                  />
                  <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{Math.round(prefs.opacity * 100)}%</span>
                </div>
              </div>
            )}

            {/* song list — auto-hidden ONLY while a track plays; the header
                List button or this section's own X open/close it manually */}
            {wide && showList && (
              <div className="max-h-52 overflow-y-auto border-t border-border/60 px-2 py-1.5">
                <div className="flex items-center justify-between px-1.5 pb-1">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    Songs {queue.length > 0 && `(${queue.length})`}
                  </span>
                  <button onClick={() => setShowList(false)} className="text-muted-foreground hover:text-foreground" title="Close the list">
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {note && <div className="px-1.5 py-1 text-[10px] leading-relaxed text-muted-foreground">{note}</div>}
                {searching && (
                  <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
                  </div>
                )}
                {!searching && !queue.length && !note && (
                  <div className="py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
                    Type a song name and press Enter,<br />
                    then tap the song you want.
                  </div>
                )}
                {queue.map(trackRow)}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
