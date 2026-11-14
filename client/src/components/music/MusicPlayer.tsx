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
 * Sizes, position and pin state persist in localStorage for every visitor
 * AND in the account's RTDB copy — the moved position follows the user
 * across devices and survives browser-storage wipes.
 */
import { useEffect, useRef, useState } from "react";
import {
  Music, Play, Pause, SkipBack, SkipForward, Search, X, Volume2,
  ChevronDown, ChevronUp, Repeat, Repeat1, Shuffle, Loader2, ListMusic, RotateCcw, Heart, Minus,
} from "lucide-react";
import { get, ref, set } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

interface Track {
  id: string;
  title: string;
  artist: string;
  art: string;
  /** direct, always-playable audio URL */
  url: string;
  duration: number;
  /** SoundCloud media transcodings URL from the search row — resolved
   *  server-side at play time (the track endpoint is datacenter-blocked) */
  hint?: string;
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
  /** active pin (top/bottom dock arrow highlight) */
  snap: "top" | "bottom" | null;
  /** last-change timestamp of THIS copy — the freshest copy (local vs cloud) wins */
  savedAt?: number;
}

// v2: the v1 key carried a saved position that could hide the widget (under
// the navbar / offscreen) — bumping the key resets EVERYONE to the default,
// always-visible spot. Only bump again if positions must be cleared.
const STORE_KEY = "inspire_music_v2";
// favorited tracks — [{id,title,artist,art,url,duration,hint}]
const FAVS_KEY = "inspire_music_favs";

function sanitize(raw: any): Persisted {
  return {
    view: raw?.view === "mini" || raw?.view === "dot" || raw?.view === "bar" ? raw.view : "dot",
    volume: typeof raw?.volume === "number" ? raw.volume : 0.8,
    opacity: typeof raw?.opacity === "number" ? Math.min(1, Math.max(0.2, raw.opacity)) : 1,
    pos:
      raw?.pos && typeof raw.pos.x === "number" && typeof raw.pos.y === "number"
        ? { x: raw.pos.x, y: raw.pos.y }
        : null,
    snap: raw?.snap === "top" || raw?.snap === "bottom" ? raw.snap : null,
    savedAt: typeof raw?.savedAt === "number" ? raw.savedAt : undefined,
  };
}

function loadPrefs(): Persisted {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORE_KEY) || "{}"));
  } catch {
    return sanitize(null);
  }
}

/** change signature WITHOUT savedAt — clamping / normalizing writes nothing */
const sigOf = (p: Persisted) =>
  JSON.stringify([p.view, p.volume, p.opacity, p.pos, p.snap]);

/**
 * Prefs state with a cloud mirror. localStorage gives the instant restore for
 * everyone (anonymous visitors too); the per-account RTDB copy
 * (`musicPrefs/{uid}`) makes the widget position follow the USER — moving it
 * on one device keeps it there on another, and a cleared browser storage can
 * no longer reset it to the default spot. Same freshness rule as the terminal
 * settings: the copy with the newest `savedAt` wins.
 */
function useMusicPrefs(): [Persisted, React.Dispatch<React.SetStateAction<Persisted>>] {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState<Persisted>(loadPrefs);
  const cloudReady = useRef(false);
  const lastSig = useRef<string>("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // cloud copy → applied only when NEWER than the local mirror
  useEffect(() => {
    if (!user) return;
    let alive = true;
    get(ref(db, `musicPrefs/${user.uid}`))
      .then((s) => {
        if (!alive || !s.exists()) return;
        const saved = s.val() as Persisted;
        if ((saved?.savedAt ?? 0) <= (loadPrefs().savedAt ?? 0)) return;
        setPrefs(sanitize(saved));
      })
      .catch(() => { /* first visit, offline or rules not yet deployed */ })
      .finally(() => {
        if (!alive) return;
        cloudReady.current = true;
        // remember what is already stored so mount-time clamping never
        // triggers a pointless cloud write
        lastSig.current = sigOf(loadPrefs());
      });
    return () => { alive = false; };
  }, [user]);

  // persist: localStorage always; RTDB debounced, real changes only
  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
    if (!user || !cloudReady.current) return;
    const sig = sigOf(prefs);
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      set(ref(db, `musicPrefs/${user.uid}`), { ...prefs, savedAt: Date.now() }).catch(() => {});
    }, 800);
  }, [prefs, user]);

  return [prefs, setPrefs];
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
        hint: typeof v.hint === "string" ? v.hint : undefined,
      }));
  } catch {
    return [];
  }
}

/** resolve the playable audio URL for a full-length track (server-side) */
async function resolveYtStream(id: string, hint?: string): Promise<string | null> {
  try {
    const q = new URLSearchParams({ id });
    if (hint) q.set("hint", hint.slice(0, 400));
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000); // fail fast → preview path
    const r = await fetch(`/api/news?music=stream&${q.toString()}`, { signal: c.signal });
    clearTimeout(t);
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
  const [prefs, setPrefs] = useMusicPrefs();
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

  // ---- favorites (localStorage — survives reloads) --------------------------
  const [favs, setFavs] = useState<Track[]>(() => {
    try { const r = JSON.parse(localStorage.getItem(FAVS_KEY) || "[]"); return Array.isArray(r) ? r : []; } catch { return []; }
  });
  const [listTab, setListTab] = useState<"queue" | "favs">("queue");
  const removeFav = (i: number) => {
    setFavs((list) => {
      const next = list.filter((_, j) => j !== i);
      try { localStorage.setItem(FAVS_KEY, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  };

  const audioRef = useRef<HTMLAudioElement>(null);
  // hls.js instance for SoundCloud HLS streams (m3u8) — destroyed on every switch
  const hlsRef = useRef<{ destroy: () => void } | null>(null);
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
  // track ids whose FULL version already failed once — the same-song retry
  // (a second row of the same track) must not loop back onto them
  const fullTriedRef = useRef<Set<string>>(new Set());
  // top/bottom pin state — derived from the persisted prefs so the active
  // dock arrow survives reloads and follows the account
  const snap = prefs.snap;
  queueRef.current = queue;
  idxRef.current = idx;
  repeatRef.current = repeat;
  shuffleRef.current = shuffle;

  const view = prefs.view;
  const setView = (v: View) => setPrefs((p) => ({ ...p, view: v }));
  const track = idx >= 0 && idx < queue.length ? queue[idx] : null;

  // favorite the CURRENT track (needs `track`, declared above)
  const isFav = !!track && favs.some((f) => f.id === track.id && f.title === track.title);
  const toggleFav = () => {
    if (!track) return;
    setFavs((list) => {
      const exists = list.some((f) => f.id === track.id);
      const next = exists
        ? list.filter((f) => f.id !== track.id)
        : [{ id: track.id, title: track.title, artist: track.artist, art: track.art, url: track.url, duration: track.duration, hint: track.hint }, ...list].slice(0, 200);
      try { localStorage.setItem(FAVS_KEY, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  };

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
      // free-dragged — no pin arrow is active anymore (persisted)
      setPrefs((p) => ({ ...p, pos: { x: sx, y: sy }, snap: null }));
    };
    const onUp = () => {
      if (dragRef.current?.moved) {
        suppressClick.current = true;
        // the click event lands right after pointerup — auto-clear so a stuck
        // flag can never make the widget permanently unclickable
        setTimeout(() => { suppressClick.current = false; }, 400);
      }
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
  // load, on every resize/orientation change, after view switches AND when
  // the song list opens/closes (the panel height changes) — using the
  // panel's REAL size, so a wide bar can never stick out of the screen
  useEffect(() => {
    const clamp = () => {
      const el = document.querySelector("[data-music-panel]") as HTMLElement | null;
      const w = el?.offsetWidth ?? 36;
      const h = el?.offsetHeight ?? 36;
      setPrefs((p) => {
        if (!p.pos) return p;
        const x = Math.min(window.innerWidth - w - 4, Math.max(4, p.pos.x));
        const y = Math.min(window.innerHeight - h - 8, Math.max(8, p.pos.y));
        return x === p.pos.x && y === p.pos.y ? p : { ...p, pos: { x, y } };
      });
    };
    const t = setTimeout(clamp, 60); // after first paint — real size available
    window.addEventListener("resize", clamp);
    window.addEventListener("orientationchange", clamp);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", clamp);
      window.removeEventListener("orientationchange", clamp);
    };
  }, [prefs.view, showList]);

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
  /** play a resolved URL — SoundCloud HLS (m3u8) goes through hls.js (lazy
   *  import, code-split); everything else (mp3/m4a) plays natively */
  const playUrl = (url: string) => {
    const el = audioRef.current;
    if (!el) return;
    if (url.includes(".m3u8")) {
      void import("hls.js")
        .then(({ default: Hls }) => {
          if (!Hls.isSupported()) {
            // Safari plays m3u8 natively
            el.src = url;
            el.play().catch(() => setPlaying(false));
            return;
          }
          hlsRef.current?.destroy();
          const h = new Hls({ maxBufferLength: 30 });
          hlsRef.current = h;
          h.attachMedia(el);
          h.loadSource(url);
          el.play().catch(() => setPlaying(false));
        })
        .catch(() => setNote("Stream loader failed — try another song"));
      return;
    }
    // leaving HLS mode: a stale hls.js instance keeps the MediaSource
    // attached and silently breaks plain mp3/m4a playback — always detach
    hlsRef.current?.destroy();
    hlsRef.current = null;
    el.src = url;
    el.play().catch(() => setPlaying(false));
  };

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
    fullTriedRef.current.add(t.id); // this full version gets one shot
    const el = audioRef.current;
    if (!el) return;
    try { el.pause(); } catch { /* ignore */ }
    setLoading(true);
    if (t.url) {
      // direct URL (Audius / iTunes preview / SoundCloud mp3) — play now
      playUrl(t.url);
    } else {
      // full-length YouTube/SoundCloud track — resolve the stream first
      void resolveYtStream(t.id, t.hint)
        .then((url) => {
          if (idxRef.current !== i) return; // the user picked another song meanwhile
          if (url) {
            playUrl(url);
          } else {
            void rescueTrack(t).then((ok) => {
              if (ok) return;
              setLoading(false);
              setNote("Couldn't load that song — try another one");
            });
          }
        })
        .catch(() => {
          // resolver itself failed (network) — same rescue path, never a
          // stuck loading spinner
          if (idxRef.current !== i) return;
          void rescueTrack(t).then((ok) => {
            if (ok) return;
            setLoading(false);
            setNote("Couldn't load that song — try another one");
          });
        });
    }
  };

  /**
   * Rescue chain when a track's full version fails — the 30s preview is the
   * LAST resort, not the first:
   *   1. another row of the SAME song with a full-length source we haven't
   *      tried (duplicate uploads, an official upload + a remix/cover …)
   *   2. the same song's iTunes 30s preview (always works)
   * Returns true when something started playing.
   */
  const rescueTrack = async (t: Track): Promise<boolean> => {
    const norm = (s: string) =>
      s.toLowerCase().replace(/\(.*?\)|\[.*?\]|official|video|audio|lyrics?|hd|4k|feat\..*$/g, "").replace(/[^a-z0-9]+/g, "").slice(0, 44);
    const target = norm(`${t.title} ${t.artist}`);
    const alt = queueRef.current.find((x) => {
      if (x.id === t.id || fullTriedRef.current.has(x.id)) return false;
      // must be a full-capable row: direct URL longer than a preview, or a
      // resolvable stream (sc_/hint) — never another dead-end row
      const fullCapable = (x.url && x.duration > 60) || (!x.url && (x.hint || x.id.startsWith("sc_")));
      if (!fullCapable) return false;
      // same song? tolerate small title/artist formatting differences
      return norm(`${x.title} ${x.artist}`) === target || norm(x.title) === norm(t.title);
    });
    if (alt) {
      const j = queueRef.current.indexOf(alt);
      if (j >= 0) {
        setNote("Trying another full-length source for this song…");
        playIndex(j);
        return true;
      }
    }
    return playPreviewFor(t);
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
      // first line of defense: the same song from another source / as a
      // short preview (async, fire-and-forget — the audio element may keep
      // firing events meanwhile)
      void rescueTrack(t).then((ok) => {
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
      hlsRef.current?.destroy();
      hlsRef.current = null;
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
    fullTriedRef.current = new Set();
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
    // 72px = below the 64px sticky navbar — pinned flush under it, never hidden
    const y = to === "top" ? 72 : Math.max(8, window.innerHeight - r.height - 8);
    const x = Math.min(Math.max(4, r.left), Math.max(4, window.innerWidth - r.width - 4));
    setPrefs((p) => ({ ...p, pos: { x, y }, snap: to }));
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
    // bounds from queueRef — the ACTUAL list being played (it can be the
    // favorites list while the `queue` state still holds the search results)
    const len = queueRef.current.length;
    const i = dir === 1 ? nextIndex(idx, false) : idx + dir < 0 ? len - 1 : idx + dir;
    if (i >= 0 && i < len) playIndex(i);
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
        className="fixed left-2 top-[7rem] z-[80] sm:left-3 sm:top-[4.25rem]"
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
              {/* position dock — its OWN bordered group, separated from the
                  view buttons: pin to top / pin to bottom / reset (the pin
                  arrows used to be mixed into the header with no state and
                  reset existed only in the wide view). Active pin glows. */}
              <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border/60 bg-muted/30 px-0.5 py-0.5" role="group" aria-label="Panel position">
                <button
                  onClick={() => snapV("top")}
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
                    snap === "top" ? "bg-emerald-500/20 text-emerald-400" : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
                  )}
                  title="Pin to top — snap under the navbar"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => snapV("bottom")}
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
                    snap === "bottom" ? "bg-emerald-500/20 text-emerald-400" : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
                  )}
                  title="Pin to bottom — snap above the bottom edge"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => { setPrefs((p) => ({ ...p, pos: null, snap: null })); }}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                  title="Reset position — back to the default corner"
                >
                  <RotateCcw className="h-3 w-3" />
                </button>
              </div>
              <button onClick={() => setView(wide ? "mini" : "bar")} className="shrink-0 text-muted-foreground hover:text-foreground" title={wide ? "Minimize" : "Expand"}>
                {wide ? <Minus className="h-4 w-4" /> : <Search className="h-4 w-4" />}
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
                  <button onClick={() => skip(-1)} className="flex h-9 w-9 items-center justify-center rounded-lg border border-border/60 bg-white/5 text-foreground transition-colors hover:bg-white/10" title="Previous">
                    <SkipBack className="h-5 w-5" />
                  </button>
                  <button
                    onClick={toggle}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105"
                    title={playing ? "Pause" : "Play"}
                  >
                    {loading && !playing ? <Loader2 className="h-4 w-4 animate-spin" /> : playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </button>
                  <button onClick={() => skip(1)} className="flex h-9 w-9 items-center justify-center rounded-lg border border-border/60 bg-white/5 text-foreground transition-colors hover:bg-white/10" title="Next">
                    <SkipForward className="h-5 w-5" />
                  </button>
                  {/* favorite the track that is playing right now */}
                  <button
                    onClick={toggleFav}
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-lg border transition-colors hover:bg-white/10",
                      isFav ? "border-rose-400/50 bg-rose-500/10 text-rose-400" : "border-border/60 bg-white/5 text-foreground/70",
                    )}
                    title={isFav ? "Remove from favorites" : "Add to favorites"}
                  >
                    <Heart className={cn("h-5 w-5", isFav && "fill-current")} />
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
                  <div className="flex gap-1">
                    <button
                      onClick={() => setListTab("queue")}
                      className={cn("rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide", listTab === "queue" ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground")}
                    >
                      Songs {queue.length > 0 && `(${queue.length})`}
                    </button>
                    <button
                      onClick={() => setListTab("favs")}
                      className={cn("flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide", listTab === "favs" ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground")}
                    >
                      <Heart className={cn("h-3 w-3", listTab === "favs" && "fill-current text-rose-400")} />Favorites {favs.length > 0 && `(${favs.length})`}
                    </button>
                  </div>
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
                {!searching && listTab === "queue" && !queue.length && !note && (
                  <div className="py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
                    Type a song name and press Enter,<br />
                    then tap the song you want.
                  </div>
                )}
                {!searching && listTab === "favs" && !favs.length && (
                  <div className="py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
                    No favorites yet — tap the ♥ button<br />
                    on the playing song to save it here.
                  </div>
                )}
                {listTab === "queue" ? queue.map(trackRow) : favs.map((t, i) => (
                  <div key={`${t.id}-${i}`} className="flex items-center gap-1 rounded-lg px-1.5 py-1 transition-colors hover:bg-muted/60">
                    <button
                      onClick={() => {
                        // switch the ACTIVE QUEUE to the favorites list, state
                        // AND ref — before, only the ref swapped (prev/next and
                        // the now-playing title kept reading the search queue)
                        setQueue(favs);
                        playIndex(i, favs);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
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
                    </button>
                    <button
                      onClick={() => removeFav(i)}
                      className="shrink-0 p-1 text-muted-foreground hover:text-red-400"
                      title="Remove from favorites"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
