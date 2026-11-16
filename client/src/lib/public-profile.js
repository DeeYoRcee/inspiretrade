export function createDefaultPublicProfileSettings() {
    return {
        enabled: false,
        visibility: {
            statistics: false,
            strategy: false,
            winRate: false,
            history: false,
            notes: false,
        },
        strategy: "",
        notes: "",
        publishedUsername: null,
        background: null,
    };
}
export function normalizePublicProfileSettings(value) {
    if (!value || typeof value !== "object")
        return createDefaultPublicProfileSettings();
    const raw = value;
    const visibility = raw.visibility && typeof raw.visibility === "object"
        ? raw.visibility
        : {};
    return {
        enabled: raw.enabled === true,
        visibility: {
            statistics: visibility.statistics === true,
            strategy: visibility.strategy === true,
            winRate: visibility.winRate === true,
            history: visibility.history === true,
            notes: visibility.notes === true,
        },
        strategy: typeof raw.strategy === "string" ? raw.strategy : "",
        notes: typeof raw.notes === "string" ? raw.notes : "",
        publishedUsername: typeof raw.publishedUsername === "string"
            ? raw.publishedUsername.toLowerCase()
            : null,
        background: typeof raw.background === "string" && raw.background ? raw.background : null,
    };
}
function calculateStatistics(trades) {
    const chronologicalTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);
    const netPnl = chronologicalTrades.reduce((total, trade) => total + trade.profit, 0);
    const grossProfit = chronologicalTrades.reduce((total, trade) => total + (trade.profit > 0 ? trade.profit : 0), 0);
    const grossLoss = chronologicalTrades.reduce((total, trade) => total + (trade.profit < 0 ? Math.abs(trade.profit) : 0), 0);
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
export function createPublicProfileSnapshot({ uid, username, displayName, trades, settings, avatar, profile, }) {
    const usernameKey = username.trim().toLowerCase();
    const snapshot = {
        uid,
        username: username.trim(),
        usernameKey,
        displayName: displayName.trim() || username.trim(),
        updatedAt: Date.now(),
    };
    // look & feel of the header — background choice + profile picture
    if (settings.background)
        snapshot.background = settings.background;
    if (avatar)
        snapshot.avatar = avatar;
    // Telegram-collectible usernames + profile video + social handles
    const held = profile?.usernames || {};
    const list = Object.entries(held)
        .slice(0, 20)
        .map(([key, v]) => ({ username: v?.username || key, key: key.toLowerCase() }));
    // the current primary is always part of the collection
    if (!list.some((u) => u.key === usernameKey))
        list.push({ username: username.trim(), key: usernameKey });
    snapshot.usernames = list;
    if (profile?.profileVideo)
        snapshot.profileVideo = profile.profileVideo;
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
export function formatPublicMoney(value) {
    const formatted = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
    }).format(Math.abs(value));
    return `${value < 0 ? "−" : "+"}${formatted}`;
}
