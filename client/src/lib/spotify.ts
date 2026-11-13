/**
 * Spotify catalog access — PKCE OAuth, 100% client-side (no server, no
 * client secret). Full-length playback of ANY song in the world catalog
 * requires the LISTENER to have Spotify Premium and log in once; search
 * runs with the same user token. Free visitors keep Audius.
 *
 * Site owner setup (once):
 *   1. Create an app at https://developer.spotify.com/dashboard
 *      (Web API + Web Playback SDK products).
 *   2. Add the site's exact URL (e.g. https://inspiretrade.vercel.app/)
 *      as a Redirect URI.
 *   3. Paste the Client ID into the player's "Setup" box — or set the
 *      VITE_SPOTIFY_CLIENT_ID build env var instead.
 */
const LS_TOKEN = "inspire_spotify_token";
const LS_CLIENT = "inspire_spotify_client";
const SS_PKCE = "inspire_spotify_pkce";

const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");

interface SpToken {
  access: string;
  refresh: string;
  expiresAt: number;
}

function redirectUri(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

export function getSpotifyClientId(): string {
  let env = "";
  try { env = (import.meta as any).env?.VITE_SPOTIFY_CLIENT_ID || ""; } catch { /* non-vite */ }
  try { return localStorage.getItem(LS_CLIENT) || env; } catch { return env; }
}

export function setSpotifyClientId(id: string): void {
  try {
    const v = id.trim();
    if (v) localStorage.setItem(LS_CLIENT, v);
    else localStorage.removeItem(LS_CLIENT);
  } catch { /* private mode */ }
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function saveToken(t: SpToken): void {
  try { localStorage.setItem(LS_TOKEN, JSON.stringify(t)); } catch { /* ignore */ }
}

/** Redirect to Spotify's consent screen. Returns false when no Client ID. */
export async function spotifyLogin(): Promise<boolean> {
  const clientId = getSpotifyClientId();
  if (!clientId) return false;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = b64url(new Uint8Array(digest));
  try { sessionStorage.setItem(SS_PKCE, verifier); } catch { /* ignore */ }
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri(),
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: SCOPES,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
  return true;
}

export function spotifyLogout(): void {
  try { localStorage.removeItem(LS_TOKEN); } catch { /* ignore */ }
}

export function spotifyLoggedIn(): boolean {
  try { return !!localStorage.getItem(LS_TOKEN); } catch { return false; }
}

async function exchange(body: URLSearchParams): Promise<SpToken | null> {
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", { method: "POST", body });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j?.access_token) return null;
    const t: SpToken = {
      access: j.access_token,
      refresh: j.refresh_token || "",
      expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60_000,
    };
    saveToken(t);
    return t;
  } catch {
    return null;
  }
}

/** Handle the ?code= redirect after consent. Returns true on new session. */
export async function spotifyHandleRedirect(): Promise<boolean> {
  try {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) return false;
    const verifier = sessionStorage.getItem(SS_PKCE) || "";
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
    const t = await exchange(new URLSearchParams({
      client_id: getSpotifyClientId(),
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }));
    return !!t;
  } catch {
    return false;
  }
}

/** A valid access token (auto-refreshes); null when logged out / expired. */
export async function spotifyToken(): Promise<string | null> {
  try {
    const raw = localStorage.getItem(LS_TOKEN);
    if (!raw) return null;
    const t: SpToken = JSON.parse(raw);
    if (Date.now() < t.expiresAt) return t.access;
    if (!t.refresh) return null;
    const nt = await exchange(new URLSearchParams({
      client_id: getSpotifyClientId(),
      grant_type: "refresh_token",
      refresh_token: t.refresh,
    }));
    return nt?.access ?? null;
  } catch {
    return null;
  }
}

export interface SpTrackMeta {
  uri: string;
  name: string;
  artist: string;
  art: string;
  durationMs: number;
}

/** Search Spotify's full world catalog (needs a user token). */
export async function spotifySearch(q: string, token: string): Promise<SpTrackMeta[]> {
  try {
    const res = await fetch(
      `https://api.spotify.com/v1/search?type=track&limit=50&q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return [];
    const j = await res.json();
    return (j?.tracks?.items ?? [])
      .filter((t: any) => t?.uri)
      .map((t: any) => ({
        uri: t.uri,
        name: t.name,
        artist: (t.artists ?? []).map((a: any) => a.name).join(", "),
        art: t.album?.images?.[1]?.url ?? t.album?.images?.[0]?.url ?? "",
        durationMs: Number(t.duration_ms) || 0,
      }));
  } catch {
    return [];
  }
}
