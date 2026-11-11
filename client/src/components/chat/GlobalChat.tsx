import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { MessageCircle, Send, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/lib/language-context";
import { useUserProfile } from "@/hooks/use-premium";
import { authedFetch } from "@/lib/api";
import { db } from "@/lib/firebase";
import { ref, push, onValue, query, limitToLast, remove, serverTimestamp } from "firebase/database";
import { cn } from "@/lib/utils";

interface ChatMessage {
  id: string;
  uid: string;
  name: string;
  username?: string;
  text: string;
  at: number;
}

const MAX_LEN = 300;
const COOLDOWN_MS = 2000;

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
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

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
      (err) => {
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

  const displayName =
    profile?.username
      ? `@${profile.username}`
      : (user.displayName || user.email?.split("@")[0] || "trader").slice(0, 60);

  const send = async () => {
    const value = text.trim().slice(0, MAX_LEN);
    if (!value || cooldown) return;
    setText("");
    setCooldown(true);
    setTimeout(() => setCooldown(false), COOLDOWN_MS);
    try {
      await push(ref(db, "chat/global"), {
        uid: user.uid,
        name: displayName,
        ...(profile?.username ? { username: profile.username } : {}),
        text: value,
        at: serverTimestamp(),
      });
    } catch (e: any) {
      // most likely: rules not published yet
      alert(t("chatSendFailed"));
    }
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
        className="fixed bottom-5 right-5 z-50 flex items-center justify-center rounded-full border border-primary/40 bg-primary p-3.5 text-primary-foreground shadow-[0_4px_24px_-4px_hsl(var(--primary)/0.7)]"
      >
        {open ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
        {!open && messages.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-black">
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
          className="fixed bottom-20 right-5 z-50 flex h-[480px] w-[min(92vw,360px)] flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/95 shadow-2xl backdrop-blur-md"
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
              <div key={m.id} className={cn("group flex gap-2", m.uid === user.uid && "flex-row-reverse")}>
                <div
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                  style={{ backgroundColor: uidColor(m.uid) }}
                >
                  {(m.name || "?").replace("@", "").slice(0, 2).toUpperCase()}
                </div>
                <div className={cn("min-w-0 max-w-[75%]", m.uid === user.uid && "text-right")}>
                  <div className={cn("flex items-center gap-1.5", m.uid === user.uid && "flex-row-reverse")}>
                    <span className={cn("text-[11px] font-bold", m.uid === user.uid ? "text-primary" : "text-muted-foreground")}>
                      {m.name}
                    </span>
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
