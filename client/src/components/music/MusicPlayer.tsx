/**
 * MusicPlayer — site-wide floating music widget. DRAG it anywhere by the
 * green music-icon handle (or the dot itself); position is persisted.
 *
 * Windows-11-Media-Player style: big cover art, seek bar with times,
 * shuffle/repeat, volume, adjustable panel transparency.
 *
 * Two music sources:
 *   spotify — after a one-time login, search the FULL WORLD CATALOG and play
 *             any track in full (requires the listener's own Spotify Premium;
 *             Web Playback SDK, client-side only). Results marked "Spotify".
 *   audius  — free fallback, full-length tracks, no login needed.
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
  ChevronDown, Repeat, Repeat1, Shuffle, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getSpotifyClientId, setSpotifyClientId, spotifyHandleRedirect, spotifyLogin,
  spotifyLogout, spotifyLoggedIn, spotifySearch, spotifyToken,
} from "@/lib/spotify";

interface Track {
  id: string;
  title: string;
  artist: string;
  art: string;
  url: string;
  duration: number;
  /** Spotify URI — when set the track plays through the Web Playback SDK */
  uri?: string;
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

/** Web Playback SDK loader (script tag + ready promise, loaded once). */
let sdkPromise: Promise<void> | null = null;
function loadSpotifySdk(): Promise<void> {
  if ((window as any).Spotify) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve) => {
    (window as any).onSpotifyWebPlaybackSDKReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    s.async = true;
    document.body.appendChild(s);
  });
  return sdkPromise;
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
  const audioRef = useRef<HTMLAudioElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; w: number; h: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  // ---- Spotify state ----
  const [spConnected, setSpConnected] = useState(spotifyLoggedIn);
  const [spDevice, setSpDevice] = useState<string | null>(null);
  const [spError, setSpError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [cidInput, setCidInput] = useState(() => getSpotifyClientId());
  const spPlayerRef = useRef<any>(null);
  const spTokenRef = useRef<string | null>(null);
  const spDeviceRef = useRef<string | null>(null);
  const spStateRef = useRef<{ position: number; duration: number; paused: boolean; uri: string | null } | null>(null);
  const spInitRef = useRef(false);
  const modeRef = useRef<"audius" | "spotify">("audius");
  const queueRef = useRef<Track[]>(queue);
  const idxRef = useRef<number>(idx);
  const repeatRef = useRef<RepeatMode>(repeat);
  const shuffleRef = useRef<boolean>(shuffle);
  queueRef.current = queue;
  idxRef.current = idx;
  repeatRef.current = repeat;
  shuffleRef.current = shuffle;
  spDeviceRef.current = spDevice;

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

  const playIndex = async (i: number) => {
    if (i < 0 || i >= queueRef.current.length) return;
    const t = queueRef.current[i];
    if (t.uri) {
      // ---- Spotify full playback (Web Playback SDK device) ----
      const token = spTokenRef.current || (await spotifyToken());
      if (!token) { setSpError("Spotify session expired — reconnect"); setPlaying(false); return; }
      spTokenRef.current = token;
      const dev = spDeviceRef.current;
      if (!dev) { setSpError("Spotify player is still connecting — try again in a second"); setIdx(i); return; }
      const uris = queueRef.current.slice(i, i + 50).filter((x) => x.uri).map((x) => x.uri!);
      try {
        const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${dev}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ uris }),
        });
        if (res.status === 403) { setSpError("Spotify Premium is required for full-track playback"); setPlaying(false); return; }
        if (res.status === 401) { setSpError("Spotify session expired — reconnect"); setPlaying(false); return; }
        if (!res.ok && res.status !== 202 && res.status !== 204) { setSpError("Spotify playback failed — try again"); return; }
        modeRef.current = "spotify";
        setSpError(null);
        setIdx(i);
        setCur(0);
        setDur(t.duration || 0);
        setPlaying(true);
      } catch {
        setSpError("Network error talking to Spotify");
      }
      return;
    }
    // ---- Audius stream (plain audio element) ----
    modeRef.current = "audius";
    const el = audioRef.current;
    if (!el) return;
    setIdx(i);
    setCur(0);
    setDur(t.duration || 0);
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
    const onPlay = () => setPlaying(true);
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

  // Spotify Web Playback SDK init (once, when a session exists)
  useEffect(() => {
    let alive = true;
    (async () => {
      const redirected = await spotifyHandleRedirect();
      if (redirected && alive) setSpConnected(true);
      if (!spotifyLoggedIn()) {
        if (redirected && alive) setSpError("Could not finish Spotify login — check the Client ID and Redirect URI (Setup)");
        return;
      }
      setSpConnected(true);
      const token = await spotifyToken();
      if (!token || !alive || spInitRef.current) return;
      spInitRef.current = true;
      spTokenRef.current = token;
      try {
        await loadSpotifySdk();
        const player = new (window as any).Spotify.Player({
          name: "InspireTrade",
          volume: prefs.volume,
          getOAuthToken: (cb: (t: string) => void) => {
            spotifyToken().then((t) => {
              if (t) { spTokenRef.current = t; cb(t); }
            });
          },
        });
        player.addListener("ready", ({ device_id }: any) => {
          if (alive) { setSpDevice(device_id); setSpError(null); }
        });
        player.addListener("not_ready", () => { if (alive) setSpDevice(null); });
        player.addListener("player_state_changed", (state: any) => {
          if (!state || !alive) return;
          const cw = state.track_window?.current_track;
          spStateRef.current = { position: state.position, duration: state.duration, paused: state.paused, uri: cw?.uri ?? null };
          setDur((state.duration || 0) / 1000);
          if (state.paused) {
            setPlaying(false);
            setCur((state.position || 0) / 1000);
            const ended = state.duration > 0 && state.position >= state.duration - 60;
            if (ended) {
              if (repeatRef.current === "one") {
                try { spPlayerRef.current?.seek(0); spPlayerRef.current?.resume(); } catch { /* ignore */ }
              } else {
                const i = nextIndex(idxRef.current, true);
                if (i >= 0) playIndex(i);
              }
            }
          } else {
            setPlaying(true);
            const qi = queueRef.current.findIndex((t) => t.uri === cw?.uri);
            if (qi >= 0 && qi !== idxRef.current) setIdx(qi);
            setCur((state.position || 0) / 1000);
          }
        });
        player.addListener("initialization_error", ({ message }: any) => { if (alive) setSpError(message); });
        player.addListener("authentication_error", ({ message }: any) => { if (alive) setSpError(message); });
        player.addListener("account_error", () => { if (alive) setSpError("Spotify Premium is required for full-track playback"); });
        player.addListener("playback_error", ({ message }: any) => { if (alive) setSpError(message); });
        await player.connect();
        spPlayerRef.current = player;
      } catch (e: any) {
        if (alive) setSpError(e?.message || "Spotify SDK failed to load");
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Spotify position ticker (SDK only pushes state on change)
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = spStateRef.current;
      if (!s || s.paused || !s.duration) return;
      s.position = Math.min(s.duration, s.position + 500);
      setCur(s.position / 1000);
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  // volume → both Audius element and Spotify SDK
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = prefs.volume;
    try { spPlayerRef.current?.setVolume?.(prefs.volume); } catch { /* not ready yet */ }
  }, [prefs.volume, spDevice]);

  const search = async () => {
    const q = term.trim();
    if (!q) return;
    setSearching(true);
    try {
      // Spotify first — the full world catalog, full-length playback.
      const token = await spotifyToken();
      if (token) {
        spTokenRef.current = token;
        const metas = await spotifySearch(q, token);
        if (metas.length) {
          setQueue(metas.map((m) => ({
            id: `s_${m.uri}`,
            title: m.name,
            artist: m.artist,
            art: m.art,
            url: "",
            duration: Math.round(m.durationMs / 1000),
            uri: m.uri,
          })));
          setIdx(-1);
          playIndex(0);
          return;
        }
      }
      // Free fallback: Audius full-length tracks (no login needed).
      const list = await audiusSearch(q);
      if (list.length > 0) { setQueue(list); setIdx(-1); playIndex(0); }
    } finally {
      setSearching(false);
    }
  };

  const connect = async () => {
    const ok = await spotifyLogin();
    if (!ok) { setSetupOpen(true); setSpError("Add your Spotify Client ID first (Setup below)"); }
  };

  const disconnect = () => {
    try { spPlayerRef.current?.pause?.(); } catch { /* ignore */ }
    spotifyLogout();
    setSpConnected(false);
    setSpDevice(null);
    spDeviceRef.current = null;
    setSpError(null);
  };

  const toggle = async () => {
    if (modeRef.current === "spotify" && spPlayerRef.current) {
      const s = spStateRef.current;
      if (s?.paused) {
        try { await spPlayerRef.current.resume(); setPlaying(true); } catch { /* ignore */ }
      } else {
        try { await spPlayerRef.current.pause(); } catch { /* ignore */ }
        setPlaying(false);
      }
      return;
    }
    const el = audioRef.current;
    if (!el || !track) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };

  const seek = (frac: number) => {
    if (modeRef.current === "spotify" && spPlayerRef.current && dur > 0) {
      try { spPlayerRef.current.seek(Math.round(frac * dur * 1000)); } catch { /* ignore */ }
      setCur(frac * dur);
      return;
    }
    const el = audioRef.current;
    if (el && dur > 0) el.currentTime = frac * dur;
  };

  const skip = (dir: 1 | -1) => {
    if (modeRef.current === "spotify" && spPlayerRef.current) {
      try { dir === 1 ? spPlayerRef.current.next() : spPlayerRef.current.previous(); } catch { /* ignore */ }
      return;
    }
    playIndex(idx + dir);
  };

  const seekFrac = dur > 0 ? cur / dur : 0;

  const trackRow = (t: Track, i: number) => (
    <button
      key={t.id}
      onClick={() => { setQueue(queue); playIndex(i); }}
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
          {t.artist} · {t.uri ? "Spotify" : "Audius"} {t.duration ? `· ${fmt(t.duration)}` : ""}
        </span>
      </span>
    </button>
  );

  // ---------- dot (1%) ----------
  if (view === "dot") {
    return (
      <>
        <audio ref={audioRef} className="hidden" />
        <div
          data-music-panel
          className="fixed left-2 top-[7rem] z-40 sm:left-3 sm:top-[4.25rem]"
          style={prefs.pos ? { left: prefs.pos.x, top: prefs.pos.y } : undefined}
        >
          <button
            onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } setView("bar"); }}
            onPointerDown={startDrag}
            className="relative flex h-9 w-9 touch-none items-center justify-center rounded-full border border-border/60 bg-[#0d1117]/90 shadow-lg backdrop-blur transition-colors hover:border-emerald-500/50 active:cursor-grabbing"
            title="Music player — drag to move"
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
      <div
        data-music-panel
        className={cn("fixed left-2 top-[7rem] z-40 sm:left-3 sm:top-[4.25rem]", wide ? "w-80" : "w-56")}
        style={prefs.pos ? { left: prefs.pos.x, top: prefs.pos.y } : undefined}
      >
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
            <button onClick={() => setView(wide ? "mini" : "bar")} className="shrink-0 text-muted-foreground hover:text-foreground" title={wide ? "Minimize" : "Expand"}>
              {wide ? <ChevronDown className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            </button>
            <button onClick={() => setView("dot")} className="shrink-0 text-muted-foreground hover:text-foreground" title="Hide (keep playing)">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Spotify row (bar only) — world catalog login / status / setup */}
          {wide && (
            <div className="flex items-center gap-1.5 border-t border-white/10 px-2.5 py-1.5 text-[10px]">
              {spConnected ? (
                <>
                  <span className={cn("font-semibold", spDevice ? "text-emerald-400" : "text-amber-400/90")}>
                    {spDevice ? "● Spotify connected" : "○ Spotify connecting…"}
                  </span>
                  <button onClick={disconnect} className="ml-auto shrink-0 text-muted-foreground hover:text-foreground">Disconnect</button>
                </>
              ) : (
                <>
                  <button onClick={connect} className="shrink-0 font-semibold text-emerald-400 hover:underline">Connect Spotify</button>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">full world catalog · Premium</span>
                  <button onClick={() => setSetupOpen((v) => !v)} className="ml-auto shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground hover:text-foreground">
                    Setup
                  </button>
                </>
              )}
            </div>
          )}

          {/* Spotify one-time setup (owner) — Client ID + Redirect URI */}
          {wide && setupOpen && (
            <div className="space-y-1.5 border-t border-white/10 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
              <p>1. Create an app at developer.spotify.com/dashboard (enable Web API + Web Playback SDK).</p>
              <p>2. Add this exact Redirect URI in the app settings:</p>
              <p className="truncate rounded bg-white/5 px-1.5 py-1 font-mono text-emerald-400">{`${window.location.origin}${window.location.pathname}`}</p>
              <div className="flex gap-1.5">
                <input
                  value={cidInput}
                  onChange={(e) => setCidInput(e.target.value)}
                  placeholder="Paste Client ID"
                  className="h-6 min-w-0 flex-1 rounded border border-white/10 bg-white/5 px-2 text-[10px] text-foreground outline-none focus:border-emerald-500/50"
                />
                <button
                  onClick={() => { setSpotifyClientId(cidInput); setSetupOpen(false); }}
                  className="shrink-0 rounded bg-emerald-500/20 px-2 text-[10px] font-bold text-emerald-400"
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {/* now playing — cover art + info (bar only) */}
          {wide && track && (
            <div className="flex items-center gap-3 px-3 pb-2 pt-2">
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
                  {track.uri ? "Spotify · Full track" : "Full track · Audius"}
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

          {/* song list — visible whenever nothing is playing, hides ONLY
              while a track is actually playing (pause → it comes back) */}
          {wide && !playing && (
            <div className="max-h-52 overflow-y-auto border-t border-white/10 px-2 py-1.5">
              {spError && <div className="px-1.5 py-1 text-[10px] leading-relaxed text-amber-400">{spError}</div>}
              {searching && (
                <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
                </div>
              )}
              {!searching && !queue.length && !spError && (
                <div className="py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
                  Search any song — results stay here.<br />
                  Connect Spotify for the full world catalog,<br />
                  or enjoy free full-length Audius tracks.
                </div>
              )}
              {queue.map(trackRow)}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
