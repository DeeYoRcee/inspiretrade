import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Crown, MessageCircle, Reply, Send, Trash2, X } from "lucide-react";
import { usePublicProfile } from "@/hooks/use-public-profile";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/lib/language-context";
import { useUserProfile } from "@/hooks/use-premium";
import { authedFetch } from "@/lib/api";
import { db } from "@/lib/firebase";
import { ref, push, get, onValue, query, limitToLast, remove, serverTimestamp } from "firebase/database";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";

interface ChatMessage {
  id: string;
  uid: string;
  name: string;
  username?: string;
  /** stamped server-side via admin chat-send — renders the CEO badge */
  ceo?: boolean;
  /** Phase 30: paid VIP (premium) member — gold VIP badge (stamped from the
   *  sender's own premium flag; cosmetic only, CEO stays server-stamped) */
  vip?: boolean;
    text: string;
    at: number;
    /** P39 — Telegram-style reply quote (optional) */
    replyTo?: { id: string; author: string; text: string };
  }

const MAX_LEN = 300;
const COOLDOWN_MS = 2000;

/** Resolve `media:{hash}` ids (and pass through URLs / data URLs) to a src. */
function mediaSrc(v: string | null | undefined): string | null {
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const m = /^media:([a-f0-9]{8,64})$/.exec(v);
  if (m) return `/api/admin?action=media-get&id=${m[1]}`;
  return v;
}

// ---------------------------------------------------------------------------
// Phase 35 fix — author-profile fallback. CEO messages were historically
// sent without a handle and may have no published snapshot yet; their photo/
// video data URLs live in users/{uid}/profile (readable by any signed-in
// user). One RTDB read per author per session (module cache + in-flight dedup).
// ---------------------------------------------------------------------------
interface AuthorMedia { avatar?: string | null; avatarVideo?: string | null; username?: string | null }

const authorCache = new Map<string, AuthorMedia>();
const authorPending = new Map<string, Promise<AuthorMedia>>();

function fetchAuthor(uid: string): Promise<AuthorMedia> {
  let pending = authorPending.get(uid);
  if (!pending) {
    pending = get(ref(db, `users/${uid}/profile`))
      .then((snap) => {
        const v = (snap.val() || {}) as AuthorMedia;
        const media: AuthorMedia = {
          avatar: typeof v.avatar === "string" ? v.avatar : null,
          avatarVideo: typeof v.avatarVideo === "string" ? v.avatarVideo : null,
          username: typeof v.username === "string" ? v.username : null,
        };
        authorCache.set(uid, media);
        return media;
      })
      .catch(() => ({}) as AuthorMedia)
      .finally(() => { authorPending.delete(uid); });
    authorPending.set(uid, pending);
  }
  return pending;
}

function useAuthorMedia(uid: string): AuthorMedia {
  const [media, setMedia] = useState<AuthorMedia>(() => (uid ? authorCache.get(uid) || {} : {}));
  useEffect(() => {
    if (!uid) return;
    const hit = authorCache.get(uid);
    if (hit) { setMedia(hit); return; }
    let alive = true;
    void fetchAuthor(uid).then((m) => { if (alive) setMedia(m); });
    return () => { alive = false; };
  }, [uid]);
  return media;
}

/**
 * Phase 33: avatar circle for a chat message. CEO/VIP senders show their REAL
 * profile photo or looping avatar video (from the public profile snapshot) —
 * the crown/star is only the fallback when they have no media set.
 */
function ChatAvatar({ m, onOpen }: { m: ChatMessage; onOpen: () => void }) {
  const isSpecial = !!(m.ceo || m.vip) && !!m.username;
  const { data: pub } = usePublicProfile(isSpecial ? m.username! : "");
  // no handle / no snapshot yet → the author's own profile doc (CEO data
  // URLs are too large for publicProfiles rules and ride the admin publish)
  const own = useAuthorMedia(isSpecial ? "" : m.uid);
  const videoSrc = mediaSrc(isSpecial ? pub?.avatarVideo : own.avatarVideo);
  const photoSrc = mediaSrc(isSpecial ? pub?.avatar : own.avatar);
  return (
    <button
      onClick={onOpen}
      className={cn(
        "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-[11px] font-bold text-white",
        m.ceo
          ? "bg-gradient-to-br from-red-500 to-red-700 text-white ring-1 ring-red-300/50"
          : m.vip
            ? "bg-gradient-to-br from-amber-400 to-yellow-600 text-black"
            : "",
        (m.username || m.ceo) && "cursor-pointer hover:opacity-85",
      )}
      style={m.ceo || m.vip ? undefined : { backgroundColor: uidColor(m.uid) }}
      title={m.username ? `@${m.username}` : undefined}
    >
      {videoSrc ? (
        <video src={videoSrc} autoPlay loop muted playsInline preload="metadata" className="h-full w-full object-cover" />
      ) : photoSrc ? (
        <img src={photoSrc} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
      ) : m.ceo ? (
        <Crown className="h-3.5 w-3.5" />
      ) : m.vip ? (
        "★"
      ) : (
        (m.name || "?").replace("@", "").slice(0, 2).toUpperCase()
      )}
    </button>
  );
}

/** Small deterministic color per uid for the avatar circle. */
function uidColor(uid: string): string {
  const hues = [190, 258, 26, 152, 340, 212, 84, 300];
  let h = 0;
  for (const c of uid) h = (h * 31 + c.charCodeAt(0)) % 997;
  return `hsl(${hues[h % hues.length]}, 62%, 52%)`;
}

/**
 * Floating global chat (like Twitch/Discord mini-chat): a bubble in the
 * bottom-right corner opens a realtime panel backed by RTDB `chat/global`.
 * Messages are written by clients (validated by rules); owners can delete.
 */
export function GlobalChat() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { data: profile } = useUserProfile();
  const isAdmin = useMemo(() => {
    const emails = String(import.meta.env.VITE_ADMIN_EMAILS || "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim());
    return !!user?.email && emails.includes(user.email.toLowerCase());
  }, [user]);

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [cooldown, setCooldown] = useState(false);
  // P39 — the message currently being replied to
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [, navigate] = useLocation();

  // Realtime subscription
  useEffect(() => {
    if (!user || !open) return;
    const chatQuery = query(ref(db, "chat/global"), limitToLast(100));
    const unsub = onValue(
      chatQuery,
      (snap) => {
        const data = (snap.val() || {}) as Record<string, Omit<ChatMessage, "id">>;
        const list: ChatMessage[] = Object.entries(data)
          .map(([id, msg]) => ({ ...msg, id }))
          .sort((a, b) => (a.at || 0) - (b.at || 0));
        setMessages(list);
      },
      (err: any) => {
        // rules not published yet / permission denied — show empty state
        console.warn("chat read failed", err?.code || err?.message);
        setMessages([]);
      },
    );
    return () => unsub();
  }, [user, open]);

  // Autoscroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, open]);

  if (!user) return null;

  const displayName = profile?.username
    ? `@${profile.username}`
    : (user.displayName || user.email?.split("@")[0] || "trader").slice(0, 60);

  const send = async () => {
    const value = text.trim().slice(0, MAX_LEN);
    if (!value || cooldown) return;
    setText("");
    setCooldown(true);
    setTimeout(() => setCooldown(false), COOLDOWN_MS);
    // P39 — Telegram-style reply quote travels with the message
    const replyPayload = replyTo
      ? { id: replyTo.id, author: replyTo.name, text: replyTo.text.slice(0, 120) }
      : null;
    try {
      if (isAdmin) {
        // the owner posts AS the CEO — the badge is stamped server-side so
        // nobody can fake it by writing to RTDB directly
        await authedFetch("/api/admin?action=chat-send", { text: value, replyTo: replyPayload });
        setReplyTo(null);
      } else {
        const base = {
          uid: user.uid,
          name: displayName,
          ...(profile?.username ? { username: profile.username } : {}),
          text: value,
          at: serverTimestamp(),
          ...(replyPayload ? { replyTo: replyPayload } : {}),
        };
        try {
          // VIP badge mirrors the paid premium flag on the sender's profile
          await push(ref(db, "chat/global"),
            profile?.isPremium || profile?.premiumPlan ? { ...base, vip: true } : base);
          setReplyTo(null);
        } catch {
          // older published rules reject vip/replyTo — retry progressively
          // barer payloads instead of failing the whole send
          const bare: Record<string, unknown> = { ...base };
          delete bare.vip;
          try {
            await push(ref(db, "chat/global"), bare);
            setReplyTo(null);
          } catch {
            delete bare.replyTo; // rules still without replyTo: send unquoted
            await push(ref(db, "chat/global"), bare);
          }
        }
      }
    } catch (e: any) {
      // most likely: rules not published yet
      alert(t("chatSendFailed"));
    }
  };

  // Phase 35 fix: CEO messages may lack a username — resolve the handle from
  // the author's profile doc when the payload doesn't carry one.
  const openProfile = async (m: ChatMessage) => {
    if (m.username) { navigate(`/@${m.username}`); return; }
    const media = await fetchAuthor(m.uid);
    if (media.username) navigate(`/@${media.username}`);
  };

  const deleteMessage = async (messageId: string) => {
    try {
      await authedFetch("/api/admin?action=chat-delete", { messageId });
      await remove(ref(db, `chat/global/${messageId}`));
    } catch {
      // not admin / network — ignore
    }
  };

  return (
    <>
      {/* Floating bubble */}
      <motion.button
        onClick={() => setOpen((v) => !v)}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.94 }}
        aria-label={t("chat")}
        className="fixed bottom-[4.75rem] end-5 z-50 flex items-center justify-center rounded-full border border-primary/40 md:bottom-5 bg-primary p-3.5 text-primary-foreground shadow-[0_4px_24px_-4px_hsl(var(--primary)/0.7)]"
      >
        {open ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
        {!open && messages.length > 0 && (
          <span className="absolute -end-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-black">
            {messages.length > 99 ? "99+" : messages.length}
          </span>
        )}
      </motion.button>

      {/* Panel */}
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.18 }}
          className="fixed bottom-[9.25rem] end-5 z-50 flex h-[min(480px,calc(100dvh-11rem))] md:bottom-20 md:h-[min(480px,calc(100dvh-8rem))] w-[min(92vw,360px)] flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/95 shadow-2xl backdrop-blur-md"
        >
          <div className="flex items-center justify-between border-b border-border/50 bg-card/80 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <MessageCircle className="h-4 w-4 text-primary" />
              <span className="text-sm font-bold">{t("chat")}</span>
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                {messages.length}
              </span>
            </div>
            <button onClick={() => setOpen(false)} className="rounded-full p-1 text-muted-foreground hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div ref={listRef} className="flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
            {messages.length === 0 && (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {t("chatEmpty")}
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} id={`chat-msg-${m.id}`} className={cn("group flex gap-2", m.uid === user.uid && "flex-row-reverse")}>
                <ChatAvatar m={m} onOpen={() => openProfile(m)} />
                <div className={cn("min-w-0 max-w-[75%]", m.uid === user.uid && "text-right")}>
                  <div className={cn("flex items-center gap-1.5", m.uid === user.uid && "flex-row-reverse")}>
                    {m.ceo ? (
                      // platform owner — RED CEO badge, links to the public profile
                      <button
                        onClick={() => openProfile(m)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border border-red-500/50 bg-red-500/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-red-400",
                          m.username && "hover:bg-red-500/25",
                        )}
                        title={m.username ? `@${m.username}` : "CEO"}
                      >
                        <Crown className="h-3 w-3" />
                        CEO
                      </button>
                    ) : m.vip ? (
                      // Phase 30: paid VIP — gold badge, links to the public profile
                      <button
                        onClick={() => openProfile(m)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border border-amber-400/50 bg-amber-400/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-300",
                          m.username && "hover:bg-amber-400/25",
                        )}
                        title={m.username ? `@${m.username}` : "VIP"}
                      >
                        ★
                        VIP
                      </button>
                    ) : (
                      <button
                        onClick={() => openProfile(m)}
                        className={cn(
                          "text-[11px] font-bold",
                          m.uid === user.uid ? "text-primary" : "text-muted-foreground",
                          m.username && "underline-offset-2 hover:text-foreground hover:underline",
                        )}
                        title={m.username ? t("viewPublicProfile") : undefined}
                      >
                        {m.name}
                      </button>
                    )}
                    <button
                      onClick={() => setReplyTo(m)}
                      aria-label="reply"
                      title="Reply"
                      className="opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
                    >
                      <Reply className="h-3 w-3" />
                    </button>
                    {isAdmin && (
                      <button
                        onClick={() => deleteMessage(m.id)}
                        aria-label="delete"
                        className="opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  {m.replyTo && (
                    <button
                      onClick={() => document.getElementById(`chat-msg-${m.replyTo!.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" })}
                      className={cn(
                        "mt-0.5 flex w-full max-w-full items-start gap-1.5 rounded-lg border-l-2 border-primary/60 bg-muted/40 px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/70",
                        m.uid === user.uid && "flex-row-reverse text-right",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="font-semibold text-foreground/80">{m.replyTo.author}: </span>
                        <span className="break-words">{m.replyTo.text}</span>
                      </span>
                    </button>
                  )}
                  <div
                    className={cn(
                      "mt-0.5 inline-block w-fit max-w-full break-words rounded-2xl px-3 py-1.5 text-sm leading-snug",
                      m.uid === user.uid
                        ? "rounded-br-sm bg-primary text-primary-foreground"
                        : "rounded-bl-sm bg-muted/70",
                    )}
                  >
                    {m.text}
                  </div>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {replyTo && (
            <div className="flex items-center gap-2 border-t border-border/50 bg-card/80 px-3 py-1.5">
              <div className="min-w-0 flex-1 rounded-lg border-l-2 border-primary/60 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                <span className="font-semibold text-foreground/80">{replyTo.name}: </span>
                <span className="break-words">{replyTo.text.slice(0, 80)}{replyTo.text.length > 80 ? "…" : ""}</span>
              </div>
              <button onClick={() => setReplyTo(null)} aria-label="cancel reply" className="shrink-0 text-muted-foreground hover:text-destructive">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <div className="border-t border-border/50 bg-card/80 p-2.5">
            <div className="flex items-center gap-2">
              <input
                value={text}
                onChange={(e) => setText(e.target.value.slice(0, MAX_LEN))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                maxLength={MAX_LEN}
                placeholder={t("chatPlaceholder")}
                className="h-10 min-w-0 flex-1 rounded-xl border border-border/60 bg-background/60 px-3.5 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/60"
              />
              <Button
                size="icon"
                onClick={send}
                disabled={cooldown || !text.trim()}
                aria-label={t("chatSend")}
                className="h-10 w-10 shrink-0 rounded-xl"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
            {cooldown && <p className="mt-1 px-1 text-[10px] text-muted-foreground">{t("chatCooldown")}</p>}
          </div>
        </motion.div>
      )}
    </>
  );
}
