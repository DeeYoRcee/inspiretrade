import type { Trade } from "@/hooks/use-trades";

export type PublicProfileSection = "statistics" | "strategy" | "winRate" | "history" | "notes";

export interface PublicProfileVisibility {
  statistics: boolean;
  strategy: boolean;
  winRate: boolean;
  history: boolean;
  notes: boolean;
}

export interface PublicProfileSettings {
  enabled: boolean;
  visibility: PublicProfileVisibility;
  strategy: string;
  notes: string;
  publishedUsername: string | null;
  /** Steam-style animated background id (see lib/profile-backgrounds). */
  background: string | null;
}

export interface PublicProfileStats {
  netPnl: number;
  totalTrades: number;
  profitFactor: number | null;
  maxDrawdown: number;
}

export interface PublicProfileTrade {
  id: string;
  assetName: string;
  type: "BUY" | "SELL";
  timestamp: number;
  profit: number;
}

export interface PublicProfileSnapshot {
  uid: string;
  username: string;
  usernameKey: string;
  displayName: string;
  updatedAt: number;
  /** platform owner — the page shows the red CEO badge instead of @handle */
  ceo?: boolean;
  /** Phase 30: paid VIP (premium) member — gold stroke + gold VIP badge */
  vip?: boolean;
  /** Steam-style animated background shown on the public page header. */
  background?: string;
  /** profile picture — 256px JPEG data URL or the auth photoURL */
  avatar?: string | null;
  /** Telegram-collectible style: every handle this profile holds */
  usernames?: { username: string; key: string }[];
  /** profile video (CEO-only for now) — plays inside the avatar circle */
  profileVideo?: string | null;
  /** uploaded avatar video (Telegram-style looping profile video) */
  avatarVideo?: string | null;
  /** social handles — rendered as Instagram / Telegram / X links */
  social?: { instagram?: string; telegram?: string; x?: string };
  /** a moved profile leaves this at the old handle — the page follows it */
  redirect?: string;
  statistics?: PublicProfileStats;
  winRate?: {
    rate: number;
    wins: number;
    total: number;
  };
  strategy?: string;
  history?: PublicProfileTrade[];
  notes?: string;
}

export function createDefaultPublicProfileSettings(): PublicProfileSettings {
  // user request (public-profile removal): the regular profile IS the public
  // profile — everything on it is visible to everyone by default. The
  // per-section chips on ProfilePage remain the privacy control.
  return {
    enabled: true,
    visibility: {
      statistics: true,
      strategy: true,
      winRate: true,
      history: true,
      notes: true,
    },
    strategy: "",
    notes: "",
    publishedUsername: null,
    background: null,
  };
}

export function normalizePublicProfileSettings(value: unknown): PublicProfileSettings {
  if (!value || typeof value !== "object") return createDefaultPublicProfileSettings();

  const raw = value as Record<string, unknown>;
  const visibility = raw.visibility && typeof raw.visibility === "object"
    ? raw.visibility as Record<string, unknown>
    : {};

  const hasStoredVisibility = raw.visibility && typeof raw.visibility === "object";
  return {
    // profiles publish by default — an old explicit disable no longer hides
    // the profile (the settings section is gone; the chips control sections)
    enabled: raw.enabled !== false,
    visibility: {
      // a stored visibility object is the user's explicit privacy choice and
      // is respected; fresh/never-published profiles are fully visible
      statistics: hasStoredVisibility ? visibility.statistics === true : true,
      strategy: hasStoredVisibility ? visibility.strategy === true : true,
      winRate: hasStoredVisibility ? visibility.winRate === true : true,
      history: hasStoredVisibility ? visibility.history === true : true,
      notes: hasStoredVisibility ? visibility.notes === true : true,
    },
    strategy: typeof raw.strategy === "string" ? raw.strategy : "",
    notes: typeof raw.notes === "string" ? raw.notes : "",
    publishedUsername: typeof raw.publishedUsername === "string"
      ? raw.publishedUsername.toLowerCase()
      : null,
    background: typeof raw.background === "string" && raw.background ? raw.background : null,
  };
}

function calculateStatistics(trades: Trade[]): PublicProfileStats {
  const chronologicalTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const netPnl = chronologicalTrades.reduce((total, trade) => total + trade.profit, 0);
  const grossProfit = chronologicalTrades.reduce(
    (total, trade) => total + (trade.profit > 0 ? trade.profit : 0),
    0,
  );
  const grossLoss = chronologicalTrades.reduce(
    (total, trade) => total + (trade.profit < 0 ? Math.abs(trade.profit) : 0),
    0,
  );

  let runningPnl = 0;
  let peakPnl = 0;
  let maxDrawdown = 0;
  for (const trade of chronologicalTrades) {
    runningPnl += trade.profit;
    peakPnl = Math.max(peakPnl, runningPnl);
    maxDrawdown = Math.max(maxDrawdown, peakPnl - runningPnl);
  }

  return {
    netPnl,
    totalTrades: chronologicalTrades.length,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxDrawdown,
  };
}

export function createPublicProfileSnapshot({
  uid,
  username,
  displayName,
  trades,
  settings,
  avatar,
  profile,
}: {
  uid: string;
  username: string;
  displayName: string;
  trades: Trade[];
  settings: PublicProfileSettings;
  avatar?: string | null;
  /** full private profile — carries usernames/social/profileVideo */
  profile?: { ceo?: boolean; vip?: boolean; usernames?: Record<string, { username: string }>; social?: { instagram?: string; telegram?: string; x?: string }; profileVideo?: string | null; avatarVideo?: string | null } | null;
}): PublicProfileSnapshot {
  const usernameKey = username.trim().toLowerCase();
  const snapshot: PublicProfileSnapshot = {
    uid,
    username: username.trim(),
    usernameKey,
    displayName: displayName.trim() || username.trim(),
    updatedAt: Date.now(),
  };

  // look & feel of the header — background choice + profile picture
  if (settings.background) snapshot.background = settings.background;
  if (avatar) snapshot.avatar = avatar;

  // Telegram-collectible usernames + profile video + social handles
  const held = profile?.usernames || {};
  const list = Object.entries(held)
    .slice(0, 20)
    .map(([key, v]) => ({ username: v?.username || key, key: key.toLowerCase() }));
  // the current primary is always part of the collection
  if (!list.some((u) => u.key === usernameKey)) list.push({ username: username.trim(), key: usernameKey });
  snapshot.usernames = list;
  // the platform-owner badge must survive every republish (the old
  // set-username only stamped it server-side on an existing snapshot)
  if (profile?.ceo) snapshot.ceo = true;
  if (profile?.vip) snapshot.vip = true;
  if (profile?.profileVideo) snapshot.profileVideo = profile.profileVideo;
  if (profile?.avatarVideo) snapshot.avatarVideo = profile.avatarVideo;
  if (profile?.social?.instagram || profile?.social?.telegram || profile?.social?.x) {
    snapshot.social = {
      instagram: profile.social.instagram || undefined,
      telegram: profile.social.telegram || undefined,
      x: profile.social.x || undefined,
    };
  }

  if (settings.visibility.statistics) {
    snapshot.statistics = calculateStatistics(trades);
  }

  if (settings.visibility.winRate) {
    const wins = trades.filter((trade) => trade.profit > 0).length;
    snapshot.winRate = {
      rate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      wins,
      total: trades.length,
    };
  }

  if (settings.visibility.strategy && settings.strategy.trim()) {
    snapshot.strategy = settings.strategy.trim();
  }

  if (settings.visibility.history) {
    snapshot.history = [...trades]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10)
      .map((trade) => ({
        id: trade.id,
        assetName: trade.assetName,
        type: trade.type,
        timestamp: trade.timestamp,
        profit: trade.profit,
      }));
  }

  if (settings.visibility.notes && settings.notes.trim()) {
    snapshot.notes = settings.notes.trim();
  }

  // The animated background is a purely visual choice — always shared while
  // the profile is published.
  if (settings.background) {
    snapshot.background = settings.background;
  }

  return snapshot;
}

export function formatPublicMoney(value: number): string {
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Math.abs(value));

  return `${value < 0 ? "−" : "+"}${formatted}`;
}
