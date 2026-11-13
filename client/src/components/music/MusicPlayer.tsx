/**
 * MusicPlayer — site-wide floating music widget. DRAG it anywhere by the
 * green music-icon handle (or the dot itself); position is persisted.
 *
 * Windows-11-Media-Player style: big cover art, seek bar with times,
 * shuffle/repeat, volume, adjustable panel transparency.
 *
 * Two music sources — NO LOGIN, NO SETUP for anyone:
 *   youtube — search the FULL WORLD CATALOG (YouTube Music via open Piped
 *             search), play any song in full through the OFFICIAL YouTube
 *             IFrame player (video shown inside the panel).
 *   audius  — free fallback, full-length tracks (decentralized platform).
 *
 * The song list is visible whenever nothing is playing and hides itself
 * ONLY while a track is actually playing (pause → list comes back).
 *
 * Three sizes, persisted in localStorage:
 *   bar  — full player (~320px)
 *   mini — "10%" strip: title + transport (~210px)
 *   dot  — "1%" dot: a single 30px round button, barely there
 */
import { useEffect, useRef, useState } from "react";
import {
  Music, Play, Pause, SkipBack, SkipForward, Search, X, Volume2,
  ChevronDown, Repeat, Repeat1, Shuffle, Loader2, ListMusic,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { loadYtIframeApi, ytSearch } from "@/lib/youtube";

interface Track {
  id: string;
  title: string;
  artist: string;
  art: string;
  url: string;
  duration: number;
  /** YouTube videoId — when set the track plays through the IFrame player */
  yt?: string;
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
      const res = await fetch(`${host}/v1/tracks/search?query=${encodeURIComponent(q)}&limit=100&app_name=InspireTrade`, {
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
        }));
      if (list.length) return list;
    } catch { /* try the next discovery node */ }
  }
  return [];
}

export function MusicPlayer() {
  const [prefs, setPrefs] = useState<Persisted>(loadPrefs);
  const [term, setTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [queue, setQueue] = useState<Track[]>([]);
  const [idx, setIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [note, setNote] = useState<string | null>(null);
  // song list visibility: auto-hidden WHILE a track plays, auto-returns on
  // pause — and the header List button / the X inside the list override it
  // manually (open the list even while playing to switch songs on demand)
  const [showList, setShowList] = useState(true);
  useEffect(() => { setShowList(!playing); }, [playing]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; w: number; h: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  // ---- YouTube player refs ----
  const ytMountRef = useRef<HTMLDivElement>(null);
  const ytRef = useRef<any>(null);
  const ytReadyRef = useRef(false);
  const ytPendingRef = useRef<string | null>(null);
  const modeRef = useRef<"audius" | "youtube">("audius");
  const queueRef = useRef<Track[]>(queue);
  const idxRef = useRef<number>(idx);
  const repeatRef = useRef<RepeatMode>(repeat);
  const shuffleRef = useRef<boolean>(shuffle);
  const prefsRef = useRef<Persisted>(prefs);
  queueRef.current = queue;
  idxRef.current = idx;
  repeatRef.current = repeat;
  shuffleRef.current = shuffle;
  prefsRef.current = prefs;

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
      setPrefs((p) => ({ ...p, pos: { x, y } }));
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

  /** next track index — respects shuffle + repeat, wraps on "all" */
  const nextIndex = (from: number, auto: boolean): number => {
    const n = queueRef.current.length;
    if (n === 0) return -1;
    if (auto && repeatRef.current === "one") return from;
    if (shuffleRef.current) return Math.floor(Math.random() * n);
    if (from + 1 < n) return from + 1;
    return auto && repeatRef.current === "all" ? 0 : -1;
  };

  // videos YouTube refuses to embed (UMG blocks) — skipped with a VISIBLE note
  const blockedRef = useRef<Set<string>>(new Set());
  // consecutive auto-skips since the last real user action / successful play
  const autoSkipRef = useRef(0);

  /** first index after `from` (wrapping) whose video is not embed-blocked */
  const nextPlayable = (from: number): number => {
    const q = queueRef.current;
    for (let s = 1; s <= q.length; s++) {
      const j = (from + s) % q.length;
      if (j === from) return -1;
      const t = q[j];
      if (t.yt && blockedRef.current.has(t.yt)) continue;
      return j;
    }
    return -1;
  };

  // ---- YouTube IFrame player (created lazily on first YouTube track) ----
  const ytEnsuringRef = useRef<Promise<any> | null>(null);
  const ytEnsure = (): Promise<any> => {
    if (ytRef.current) return Promise.resolve(ytRef.current);
    // single-flight: never create two players when playIndex fires twice fast
    if (ytEnsuringRef.current) return ytEnsuringRef.current;
    ytEnsuringRef.current = (async () => {
      try {
        await loadYtIframeApi();
      } catch {
        return null;
      }
      const YT = (window as any).YT;
      const mount = ytMountRef.current;
      if (!YT?.Player || !mount) return null;
      // The host div is created imperatively: YT replaces it with an iframe,
      // so React must not own that node (avoids reconciliation crashes).
      const host = document.createElement("div");
      mount.appendChild(host);
      ytRef.current = new YT.Player(host, {
        width: "100%",
        height: "100%",
        playerVars: { autoplay: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: () => {
            ytReadyRef.current = true;
            try { ytRef.current?.setVolume(Math.round(prefsRef.current.volume * 100)); } catch { /* ignore */ }
            if (ytPendingRef.current) {
              const id = ytPendingRef.current;
              ytPendingRef.current = null;
              try { ytRef.current?.loadVideoById(id); } catch { /* ignore */ }
            }
          },
          onStateChange: (e: any) => {
            const S = (window as any).YT.PlayerState;
            if (e.data === S.PLAYING) {
              // ghost-video guard: the user switched to Audius while this
              // video was still loading — silence it IMMEDIATELY
              if (modeRef.current !== "youtube") {
                try { ytRef.current?.pauseVideo?.(); } catch { /* ignore */ }
                return;
              }
              autoSkipRef.current = 0;
              setPlaying(true);
            } else if (e.data === S.PAUSED) {
              setPlaying(false);
            } else if (e.data === 0) {
              // ended → advance (respects shuffle / repeat)
              const i = nextIndex(idxRef.current, true);
              if (i >= 0) playIndex(i);
              else setPlaying(false);
            }
          },
          onError: () => {
            // stale error from a video we already abandoned → ignore
            if (modeRef.current !== "youtube") return;
            // Embed-blocked / region-locked. NEVER silently wander off —
            // remember the video, tell the user, move on at most twice.
            const curTrack = queueRef.current[idxRef.current];
            if (curTrack?.yt) blockedRef.current.add(curTrack.yt);
            if (autoSkipRef.current >= 2) {
              setPlaying(false);
              setNote(`"${curTrack?.title ?? "This song"}" can't be played (embedding blocked) — pick another one from the list`);
              return;
            }
            const skipCount = autoSkipRef.current + 1;
            const next = nextPlayable(idxRef.current);
            if (next >= 0) {
              const t = queueRef.current[next];
              setNote(`"${curTrack?.title ?? "It"}" can't be embedded — playing "${t.title}" instead`);
              playIndex(next);
              // playIndex resets the counter as a "user action" — this skip
              // is NOT one, so restore the cascade count (bounded retries)
              autoSkipRef.current = skipCount;
            } else {
              setPlaying(false);
              setNote("No playable results for this search — try another song");
            }
          },
        },
      });
      return ytRef.current;
    })().finally(() => { ytEnsuringRef.current = null; });
    return ytEnsuringRef.current;
  };

  const playIndex = async (i: number, list?: Track[]) => {
    // explicit list beats the (possibly stale) ref — the "wrong song" bug
    if (list) queueRef.current = list;
    const q = queueRef.current;
    if (i < 0 || i >= q.length) return;
    const t = q[i];
    setIdx(i);
    setCur(0);
    setDur(t.duration || 0);
    setNote(null);
    autoSkipRef.current = 0; // a real user action — reset the skip cascade
    if (t.yt) {
      // ---- YouTube full playback (official IFrame player) ----
      modeRef.current = "youtube";
      ytPendingRef.current = null;
      // cross-source stop — never let two songs play at once
      try { audioRef.current?.pause(); } catch { /* ignore */ }
      setPlaying(true);
      const p = await ytEnsure();
      if (!p) { setPlaying(false); setNote("YouTube player could not load — try Audius results"); return; }
      if (ytReadyRef.current) {
        try { p.loadVideoById(t.yt); } catch { setPlaying(false); }
      } else {
        ytPendingRef.current = t.yt;
      }
      return;
    }
    // ---- Audius stream (plain audio element) ----
    modeRef.current = "audius";
    ytPendingRef.current = null;
    // cross-source stop — hard-stop any YouTube video still sounding
    // (stopVideo, not pauseVideo: mid-load videos ignore pause and would
    // auto-start later → the "two songs / wrong song" bug)
    try { ytRef.current?.stopVideo?.(); } catch { /* ignore */ }
    const el = audioRef.current;
    if (!el) return;
    el.src = t.url;
    el.play().catch(() => setPlaying(false));
  };

  // audio element wiring (single persistent element — Audius path)
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.volume = prefs.volume;
    const onTime = () => setCur(el.currentTime);
    const onMeta = () => setDur(el.duration || 0);
    const onPlay = () => {
      // ghost-audio guard: a YouTube track owns playback right now — silence it
      if (modeRef.current !== "audius") { try { el.pause(); } catch { /* ignore */ } return; }
      setPlaying(true);
    };
    const onPause = () => setPlaying(false);
    const onEnd = () => {
      const i = nextIndex(idxRef.current, true);
      if (i >= 0) {
        if (i === idxRef.current) { el.currentTime = 0; el.play().catch(() => {}); }
        else playIndex(i);
      }
    };
    const onError = () => {
      // broken stream (Audius node hiccup) — skip forward, never hang
      const i = nextIndex(idxRef.current, false);
      if (i >= 0 && i !== idxRef.current) playIndex(i);
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

  // position ticker — YouTube only pushes state on change, poll gently
  useEffect(() => {
    const id = window.setInterval(() => {
      if (modeRef.current === "youtube" && ytRef.current && ytReadyRef.current) {
        try {
          const s = ytRef.current.getPlayerState?.();
          const d = ytRef.current.getDuration?.() || 0;
          if (d > 0) setDur(d);
          if (s === 1) {
            setPlaying(true);
            setCur(ytRef.current.getCurrentTime?.() || 0);
          } else if (s === 2) {
            setPlaying(false);
          }
        } catch { /* ignore */ }
      }
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  // volume → both Audius element and YouTube player
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = prefs.volume;
    try { ytRef.current?.setVolume?.(Math.round(prefs.volume * 100)); } catch { /* not ready yet */ }
  }, [prefs.volume]);

  // destroy the YouTube player on final unmount
  useEffect(() => () => {
    try { ytRef.current?.destroy?.(); } catch { /* ignore */ }
  }, []);

  const search = async () => {
    const q = term.trim();
    if (!q) return;
    setSearching(true);
    setNote(null);
    blockedRef.current = new Set(); // fresh search → fresh blocking info
    try {
      // 1) YouTube Music — the FULL WORLD CATALOG, full-length, no login.
      const yt = await ytSearch(q);
      if (yt.length) {
        const list: Track[] = yt.map((m) => ({
          id: `y_${m.videoId}`,
          title: m.title,
          artist: m.artist,
          art: m.thumb,
          url: "",
          duration: m.duration,
          yt: m.videoId,
        }));
        setQueue(list);
        setIdx(-1);
        // pass the NEW list explicitly — never play a track from the old queue
        playIndex(0, list);
        return;
      }
      // 2) Free fallback: Audius full-length tracks.
      const list = await audiusSearch(q);
      if (list.length > 0) { setQueue(list); setIdx(-1); playIndex(0, list); }
    } finally {
      setSearching(false);
    }
  };

  const toggle = () => {
    if (modeRef.current === "youtube" && ytRef.current && ytReadyRef.current) {
      const s = ytRef.current.getPlayerState?.();
      if (s === 1) {
        try { ytRef.current.pauseVideo(); } catch { /* ignore */ }
        setPlaying(false);
      } else {
        try { ytRef.current.playVideo(); } catch { /* ignore */ }
        setPlaying(true);
      }
      return;
    }
    const el = audioRef.current;
    if (!el || !track) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };

  const seek = (frac: number) => {
    if (modeRef.current === "youtube" && ytRef.current && ytReadyRef.current && dur > 0) {
      try { ytRef.current.seekTo(Math.round(frac * dur), true); } catch { /* ignore */ }
      setCur(frac * dur);
      return;
    }
    const el = audioRef.current;
    if (el && dur > 0) el.currentTime = frac * dur;
  };

  const skip = (dir: 1 | -1) => {
    if (modeRef.current === "youtube") {
      const i = nextIndex(idx, false);
      if (i >= 0) playIndex(i);
      return;
    }
    playIndex(idx + dir);
  };

  const wide = view === "bar";

  const seekFrac = dur > 0 ? cur / dur : 0;

  const trackRow = (t: Track, i: number) => (
    <button
      key={t.id}
      onClick={() => { setQueue(queue); playIndex(i, queue); }}
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
          {t.artist} · {t.yt ? "YouTube Music" : "Audius"} {t.duration ? `· ${fmt(t.duration)}` : ""}
        </span>
      </span>
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
        {/* dot (1%) — CSS-shown only in dot view */}
        <button
          onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } setView("bar"); }}
          onPointerDown={startDrag}
          className={cn(
            "relative h-9 w-9 touch-none items-center justify-center rounded-full border border-border/60 bg-[#0d1117]/90 shadow-lg backdrop-blur transition-colors hover:border-emerald-500/50 active:cursor-grabbing",
            view === "dot" ? "flex" : "hidden",
          )}
          title="Music player — drag to move"
        >
          <Music className="h-4 w-4 text-emerald-400" />
          {playing && <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400" />}
        </button>

        {/* card (bar / mini) — CSS-hidden (never unmounted) in dot view, so the
            YouTube player element survives every view switch */}
        <div className={cn(view !== "dot" ? "block" : "hidden", wide ? "w-80" : "w-56")}>
          <div
            className="overflow-hidden rounded-2xl border border-white/10 bg-[#101418]/95 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.8)] backdrop-blur-xl"
            style={{ opacity: prefs.opacity }}
          >
            {/* header: drag handle + search (bar) / title (mini) + view switches */}
            <div className="flex items-center gap-1.5 px-2.5 py-2">
              <div
                onPointerDown={startDrag}
                className="flex h-7 w-7 shrink-0 touch-none cursor-grab items-center justify-center rounded-md text-emerald-400 hover:bg-white/5 active:cursor-grabbing"
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
                    placeholder="Search any song…"
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
              {wide && (
                <button
                  onClick={() => setShowList((v) => !v)}
                  className={cn("shrink-0 text-muted-foreground hover:text-foreground", showList && "text-emerald-400")}
                  title="Song list — open/close (works while playing)"
                >
                  <ListMusic className="h-4 w-4" />
                </button>
              )}
              <button onClick={() => setView(wide ? "mini" : "bar")} className="shrink-0 text-muted-foreground hover:text-foreground" title={wide ? "Minimize" : "Expand"}>
                {wide ? <ChevronDown className="h-4 w-4" /> : <Search className="h-4 w-4" />}
              </button>
              <button onClick={() => setView("dot")} className="shrink-0 text-muted-foreground hover:text-foreground" title="Hide (keep playing)">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* visible notice — shown EVEN while playing (embed-blocked skips,
                player failures) so the user always knows why a song changed */}
            {wide && note && (
              <div className="mx-3 mb-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] leading-relaxed text-amber-400">
                {note}
              </div>
            )}

            {/* now playing — cover art (Audius) */}
            {wide && track && !track.yt && (
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
                    Full track · Audius
                  </p>
                </div>
              </div>
            )}

            {/* YouTube host — ALWAYS mounted (player must never be destroyed);
                visible only while a YouTube song plays in bar view */}
            <div className={cn("mx-3 overflow-hidden rounded-xl bg-black", wide && track?.yt ? "mb-2 block aspect-video" : "hidden")}>
              <div ref={ytMountRef} className="h-full w-full" />
            </div>

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
                  <button onClick={() => skip(-1)} className="text-foreground/80 hover:text-foreground" title="Previous">
                    <SkipBack className="h-4 w-4" />
                  </button>
                  <button
                    onClick={toggle}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500 text-black shadow-lg transition-transform hover:scale-105"
                    title={playing ? "Pause" : "Play"}
                  >
                    {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </button>
                  <button onClick={() => skip(1)} className="text-foreground/80 hover:text-foreground" title="Next">
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
                {/* panel transparency — lower % = more see-through */}
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">Transparency</span>
                  <input
                    type="range" min={20} max={100} step={5} value={Math.round(prefs.opacity * 100)}
                    onChange={(e) => setPrefs((p) => ({ ...p, opacity: Number(e.target.value) / 100 }))}
                    className="h-1 flex-1 cursor-pointer accent-emerald-400"
                    title="Panel transparency"
                  />
                  <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{Math.round(prefs.opacity * 100)}%</span>
                </div>
              </div>
            )}

            {/* song list ("Songs" section) — auto-hidden ONLY while a track
                is playing; the header List button or this section's own X
                open/close it manually (switch songs without pausing) */}
            {wide && showList && (
              <div className="max-h-52 overflow-y-auto border-t border-white/10 px-2 py-1.5">
                <div className="flex items-center justify-between px-1.5 pb-1">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    Songs {queue.length > 0 && `(${queue.length})`}
                  </span>
                  <button onClick={() => setShowList(false)} className="text-muted-foreground hover:text-foreground" title="Close the list">
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {note && <div className="px-1.5 py-1 text-[10px] leading-relaxed text-amber-400">{note}</div>}
                {searching && (
                  <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
                  </div>
                )}
                {!searching && !queue.length && !note && (
                  <div className="py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
                    Search any song — the full world catalog<br />
                    plays in full, no login needed.<br />
                    Free Audius tracks as fallback.
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
