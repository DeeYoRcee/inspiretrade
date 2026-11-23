/**
 * SupportInbox — PHASE 60 Task 4: the owner's view of every user's PRIVATE
 * support thread. Data comes through /api/admin?action=support (admin SDK
 * bypasses RTDB rules — the owner's client can never read other users'
 * threads directly, by design).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, Headset, Send, ShieldCheck } from "lucide-react";
import { authedFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";

interface ThreadSummary {
  uid: string;
  name: string | null;
  lastText: string;
  lastAt: number;
  fromLast: string | null;
  total: number;
  awaitingReply: boolean;
}
interface SupportMsg {
  id: string;
  uid?: string;
  name?: string;
  text?: string;
  at?: number;
  from?: "user" | "support";
}

async function api<T>(body: Record<string, unknown>): Promise<T> {
  const res = await authedFetch("/api/admin?action=support", body);
  return res as T;
}

export function SupportInbox() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [openUid, setOpenUid] = useState<string | null>(null);
  const [reply, setReply] = useState("");

  const threads = useQuery({
    queryKey: ["support-threads"],
    queryFn: () => api<{ threads: ThreadSummary[] }>({ op: "threads" }),
    refetchInterval: 30_000,
  });
  const thread = useQuery({
    queryKey: ["support-thread", openUid],
    queryFn: () => api<{ messages: SupportMsg[] }>({ op: "thread", uid: openUid }),
    enabled: !!openUid,
    refetchInterval: 15_000,
  });

  const replyMut = useMutation({
    mutationFn: (vars: { uid: string; text: string }) => api({ op: "reply", ...vars }),
    onSuccess: () => {
      setReply("");
      toast({ title: t("supportReplySent") });
      qc.invalidateQueries({ queryKey: ["support-thread", openUid] });
      qc.invalidateQueries({ queryKey: ["support-threads"] });
    },
    onError: (e: any) => toast({ title: t("error"), description: String(e?.message || ""), variant: "destructive" }),
  });

  const list = threads.data?.threads ?? [];

  return (
    <Card className="glass-panel border-border/50">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Headset className="h-5 w-5 text-sky-400" />
          {t("supportInboxTitle")}
          {list.some((x) => x.awaitingReply) && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-400">
              {list.filter((x) => x.awaitingReply).length} {t("supportAwaiting")}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {openUid ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpenUid(null)} className="h-7 gap-1 text-xs">
              <ArrowLeft className="h-3.5 w-3.5" />
              {t("supportBack")}
            </Button>
            <div className="max-h-80 space-y-2 overflow-y-auto rounded-xl border border-border/50 bg-background/40 p-3">
              {(thread.data?.messages ?? []).map((m) => {
                const mine = m.from === "support";
                return (
                  <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
                    <div
                      className={cn(
                        "max-w-[80%] rounded-2xl px-3 py-1.5 text-sm",
                        mine ? "bg-sky-500/20 text-foreground" : "bg-muted/60 text-foreground",
                      )}
                    >
                      <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                        {mine ? "Support" : (m.name || "User")} · {m.at ? new Date(m.at).toLocaleString() : ""}
                      </div>
                      {m.text}
                    </div>
                  </div>
                );
              })}
              {!thread.data?.messages?.length && (
                <p className="py-6 text-center text-xs text-muted-foreground">{t("supportEmptyThread")}</p>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                value={reply}
                onChange={(e) => setReply(e.target.value.slice(0, 1000))}
                onKeyDown={(e) => { if (e.key === "Enter" && reply.trim()) replyMut.mutate({ uid: openUid, text: reply.trim() }); }}
                placeholder={t("supportReplyPlaceholder")}
                className="h-9 rounded-xl"
              />
              <Button
                size="icon"
                disabled={!reply.trim() || replyMut.isPending}
                onClick={() => replyMut.mutate({ uid: openUid, text: reply.trim() })}
                className="h-9 w-9 shrink-0 rounded-xl bg-sky-500 text-white hover:bg-sky-500/90"
                aria-label={t("supportSendReply")}
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-1.5">
            {list.map((th) => (
              <button
                key={th.uid}
                onClick={() => setOpenUid(th.uid)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition hover:bg-accent/40",
                  th.awaitingReply ? "border-amber-400/40 bg-amber-500/5" : "border-border/50",
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-semibold">
                    {th.name || th.uid.slice(0, 8)}
                    {th.awaitingReply && <span className="h-2 w-2 rounded-full bg-amber-400" title={t("supportAwaiting")} />}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{th.lastText}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[10px] text-muted-foreground">{th.lastAt ? new Date(th.lastAt).toLocaleDateString() : ""}</div>
                  <div className="text-[10px] font-bold text-muted-foreground">{th.total}</div>
                </div>
              </button>
            ))}
            {!list.length && (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
                <ShieldCheck className="h-8 w-8 text-sky-400/60" />
                <p className="text-sm">{t("supportNoThreads")}</p>
                <p className="text-xs">{t("supportNoThreadsDesc")}</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
