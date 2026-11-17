/**
 * PlatformAdmin — Phase 7 platform management dashboard: overview analytics,
 * user management, live trading monitor, admin notifications and platform
 * settings + roles. Every action runs through /api/admin (role matrix
 * enforced server-side); this UI only mirrors the caller's permissions.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard, Users, Activity, BellRing, Settings2, Search, RefreshCw, Loader2,
  CirclePause, CirclePlay, ShieldBan, ShieldCheck, NotebookPen, Trophy,
} from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import {
  platformApi, type AdminUserDetail, type AdminAnalytics, type MonitorData, type PlatformSettingsShape,
} from "@/lib/platform-api";
import { cn } from "@/lib/utils";

const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const date = (t: number | null | undefined) => (t ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }) : "—");

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" | "warn" }) {
  return (
    <Card className="glass-panel border-border/50">
      <CardContent className="p-3">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className={cn(
          "font-number text-xl font-bold",
          tone === "up" && "text-emerald-400", tone === "down" && "text-red-400", tone === "warn" && "text-amber-400",
        )}>{value}</p>
        {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function MiniChart({ data, color, title }: { data: { day: string; count: number }[]; color: string; title: string }) {
  return (
    <Card className="glass-panel border-border/50">
      <CardContent className="p-4">
        <p className="mb-2 text-sm font-semibold">{title}</p>
        <div className="h-36">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 2, right: 6, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} interval={4} />
              <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} allowDecimals={false} width={26} />
              <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, fontSize: 12 }} />
              <Area type="monotone" dataKey="count" stroke={color} fill={color} fillOpacity={0.18} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function OverviewSection() {
  const { t } = useLanguage();
  const q = useQuery({ queryKey: ["admin-analytics"], queryFn: platformApi.analytics, refetchInterval: 60_000 });
  const a: AdminAnalytics | undefined = q.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label={t("adminTotalUsers")} value={a ? String(a.users.total) : "…"} sub={a ? `${a.users.suspended} suspended` : undefined} />
        <StatCard label={t("adminActiveUsers")} value={a ? String(a.users.active30d) : "…"} tone="up" />
        <StatCard label={t("adminNewUsers")} value={a ? String(a.users.new30d) : "…"} />
        <StatCard label={t("adminTotalAccounts")} value={a ? String(a.accounts.total) : "…"} sub={a ? `${a.accounts.demo} demo · ${a.accounts.challenge} challenge` : undefined} />
        <StatCard label={t("adminActiveChallenges")} value={a ? String(a.accounts.challengeActive) : "…"} />
        <StatCard label={t("adminPassedChallenges")} value={a ? String(a.accounts.challengePassed) : "…"} tone="up" />
        <StatCard label={t("adminFailedChallenges")} value={a ? String(a.accounts.challengeFailed) : "…"} tone="down" />
        <StatCard label={t("adminOpenPositions")} value={a ? String(a.trading.openPositions) : "…"} tone={a && a.trading.openPositions > 0 ? "warn" : undefined} />
        <StatCard label={t("adminClosedTrades")} value={a ? String(a.trading.closedTrades) : "…"} />
        <StatCard label={t("adminVolume")} value={a ? money(a.trading.volumeUsd) : "…"} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <MiniChart data={a?.users.registrationsByDay || []} color="#38bdf8" title={t("adminRegistrations")} />
        <MiniChart data={a?.activity.tradesByDay || []} color="#a78bfa" title={t("adminTradesPerDay")} />
      </div>
    </div>
  );
}

function UserRowDetail({ uid, onClose }: { uid: string; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const q = useQuery({ queryKey: ["admin-user", uid], queryFn: () => platformApi.userDetail(uid) });
  const d: AdminUserDetail | undefined = q.data;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-user", uid] });
    queryClient.invalidateQueries({ queryKey: ["admin-users"] });
  };
  const state = useMutation({
    mutationFn: (action: "suspend" | "reactivate" | "restrict" | "unrestrict") => platformApi.setUserState(uid, action),
    onSuccess: () => { toast({ title: t("adminSettingsSaved") }); invalidate(); },
    onError: (e: any) => toast({ title: t("serverError"), description: String(e?.message || ""), variant: "destructive" }),
  });
  const addNote = useMutation({
    mutationFn: () => platformApi.addNote(uid, note.trim()),
    onSuccess: () => { setNote(""); invalidate(); },
    onError: (e: any) => toast({ title: t("serverError"), description: String(e?.message || ""), variant: "destructive" }),
  });

  return (
    <Card className="glass-panel border-primary/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            {q.isFetching && <Loader2 className="h-4 w-4 animate-spin" />}
            {d ? `${d.displayName} · ${d.email}` : t("adminUserDetail")}
          </span>
          <div className="flex gap-1.5">
            {d && !d.disabled && (
              <Button size="sm" variant="outline" className="h-8 rounded-full border-red-500/40 text-red-400" disabled={state.isPending} onClick={() => state.mutate("suspend")}>
                <CirclePause className="h-3.5 w-3.5" />{t("adminSuspendUser")}
              </Button>
            )}
            {d && d.disabled && (
              <Button size="sm" variant="outline" className="h-8 rounded-full border-emerald-500/40 text-emerald-400" disabled={state.isPending} onClick={() => state.mutate("reactivate")}>
                <CirclePlay className="h-3.5 w-3.5" />{t("adminReactivateUser")}
              </Button>
            )}
            {d && !d.restricted && !d.disabled && (
              <Button size="sm" variant="outline" className="h-8 rounded-full border-amber-500/40 text-amber-400" disabled={state.isPending} onClick={() => state.mutate("restrict")}>
                <ShieldBan className="h-3.5 w-3.5" />{t("adminRestrictTrading")}
              </Button>
            )}
            {d && d.restricted && (
              <Button size="sm" variant="outline" className="h-8 rounded-full border-emerald-500/40 text-emerald-400" disabled={state.isPending} onClick={() => state.mutate("unrestrict")}>
                <ShieldCheck className="h-3.5 w-3.5" />{t("adminUnrestrictTrading")}
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-8 rounded-full" onClick={onClose}>✕</Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {d && (
          <>
            <div className="flex flex-wrap gap-1.5 text-xs">
              <Badge variant="outline" className="rounded-full">{d.uid}</Badge>
              <Badge variant="outline" className="rounded-full">{d.disabled ? "suspended" : d.restricted ? "trading restricted" : "active"}</Badge>
              {d.ceo && <Badge variant="outline" className="rounded-full border-amber-500/40 text-amber-400">CEO</Badge>}
              {d.role && <Badge variant="outline" className="rounded-full border-primary/40 text-primary">{d.role}</Badge>}
              <Badge variant="outline" className="rounded-full font-number">{d.economy.coins ?? 0} {t("adminCoins")}</Badge>
              <span className="text-muted-foreground">{t("adminRegistered")}: {date(d.creationTime)} · {t("adminLastSeen")}: {date(d.lastSignInTime)}</span>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold text-muted-foreground">{t("adminChallengeProgress")}: {d.challengeProgress.assigned} assigned · <span className="text-emerald-400">{d.challengeProgress.passed} passed</span> · <span className="text-red-400">{d.challengeProgress.failed} failed</span> · {d.challengeProgress.active} active · {d.challengeProgress.totalTrades} trades ({d.challengeProgress.wins} wins)</p>
              <div className="space-y-1.5">
                {d.accounts.map((acc) => (
                  <div key={acc.aid} className="rounded-lg border border-border/40 bg-card/40 px-2.5 py-1.5 text-xs">
                    <b>{acc.challengeName || acc.label}</b> · {money(acc.startingBalance)} → <span className="font-number">{money(acc.balance)}</span> ({acc.profitPct >= 0 ? "+" : ""}{acc.profitPct}%) · {acc.status}{acc.adminSuspended ? " · suspended" : ""}{acc.failedReason ? ` · ${acc.failedReason}` : ""}
                  </div>
                ))}
                {d.accounts.length === 0 && <p className="text-xs text-muted-foreground">{t("adminEmpty")}</p>}
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold text-muted-foreground">{t("adminNotes")}</p>
              <div className="mb-1.5 flex gap-1.5">
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("adminNotePlaceholder")} className="h-9 rounded-lg text-xs" />
                <Button size="sm" className="h-9 rounded-lg" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate()}>
                  <NotebookPen className="h-3.5 w-3.5" />{t("adminAddNote")}
                </Button>
              </div>
              {d.notes.map((n) => (
                <p key={n.id} className="border-t border-border/30 py-1 text-xs text-muted-foreground"><b className="text-foreground">{n.by}</b> · {date(n.at)} — {n.text}</p>
              ))}
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold text-muted-foreground">{t("adminActivity")}</p>
              {d.activity.slice(0, 8).map((e) => (
                <p key={e.id} className="border-t border-border/30 py-1 text-xs text-muted-foreground">{date(e.at)} — {e.type || "event"} {e.amount != null ? `(${e.amount > 0 ? "+" : ""}${e.amount})` : ""} {e.note ? `· ${e.note}` : ""}</p>
              ))}
              {d.activity.length === 0 && <p className="text-xs text-muted-foreground">{t("adminEmpty")}</p>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function UsersSection() {
  const { t } = useLanguage();
  const [qText, setQText] = useState("");
  const [status, setStatus] = useState("all");
  const [openUid, setOpenUid] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["admin-users", qText, status],
    queryFn: () => platformApi.usersList(qText.trim(), status),
  });
  const users = q.data?.users || [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={qText} onChange={(e) => setQText(e.target.value)} placeholder={t("adminSearchPlaceholder")} className="h-10 rounded-xl pl-9" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[150px] rounded-xl"><SelectValue /></SelectTrigger>
          <SelectContent className="glass-panel border-border/60">
            <SelectItem value="all">{t("adminFilterAll")}</SelectItem>
            <SelectItem value="active">active</SelectItem>
            <SelectItem value="suspended">suspended</SelectItem>
            <SelectItem value="recent">recent 30d</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" className="h-10 rounded-xl" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4" /></Button>
      </div>
      <p className="text-xs text-muted-foreground">{q.data ? `${q.data.filtered} / ${q.data.total}` : "…"}</p>
      <div className="space-y-1.5">
        {users.map((u) => (
          <button key={u.uid} className={cn("w-full rounded-xl border px-3 py-2 text-left transition-colors", openUid === u.uid ? "border-primary/40 bg-primary/5" : "border-border/50 bg-card/50 hover:border-primary/30")}
            onClick={() => setOpenUid(openUid === u.uid ? null : u.uid)}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {u.displayName}
                <span className="text-xs font-normal text-muted-foreground">{u.email}</span>
                {u.disabled && <Badge variant="outline" className="rounded-full border-red-500/40 text-[9px] text-red-400">suspended</Badge>}
                {u.restricted && !u.disabled && <Badge variant="outline" className="rounded-full border-amber-500/40 text-[9px] text-amber-400">restricted</Badge>}
                {u.role && <Badge variant="outline" className="rounded-full border-primary/40 text-[9px] text-primary">{u.role}</Badge>}
              </span>
              <span className="font-number text-xs text-muted-foreground">{u.coins ?? 0} {t("adminCoins")} · {date(u.creationTime)}</span>
            </div>
          </button>
        ))}
        {users.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t("adminEmpty")}</p>}
      </div>
      {openUid && <UserRowDetail uid={openUid} onClose={() => setOpenUid(null)} />}
    </div>
  );
}

function MonitorSection() {
  const { t } = useLanguage();
  const [userFilter, setUserFilter] = useState("");
  const [symbolFilter, setSymbolFilter] = useState("");
  const q = useQuery({ queryKey: ["admin-monitor"], queryFn: platformApi.liveMonitor, refetchInterval: 20_000 });
  const d: MonitorData | undefined = q.data;
  const flagLabel = (f: string) =>
    f === "risk" ? t("adminFlagRisk") : f === "heavy_book" ? t("adminFlagHeavy") : f === "high_exposure" ? t("adminFlagExposure")
      : f === "suspended" ? t("adminFlagSuspended") : f === "failed" ? t("adminFlagFailed") : f;
  const accounts = (d?.accounts || []).filter((a) =>
    (!userFilter || a.traderName.toLowerCase().includes(userFilter.toLowerCase()) || a.uid.includes(userFilter.toLowerCase()))
    && (!symbolFilter || a.positions.some((p) => p.symbol.toLowerCase().includes(symbolFilter.toLowerCase()))),
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Input value={userFilter} onChange={(e) => setUserFilter(e.target.value)} placeholder="trader / uid" className="h-10 max-w-[220px] rounded-xl" />
        <Input value={symbolFilter} onChange={(e) => setSymbolFilter(e.target.value)} placeholder="symbol" className="h-10 max-w-[160px] rounded-xl" />
        <Button variant="outline" className="h-10 rounded-xl" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4" /></Button>
        <span className="self-center text-xs text-muted-foreground">{d ? `${d.openAccounts} ${t("adminOpenAccounts")}` : "…"}</span>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="glass-panel border-border/50">
          <CardContent className="p-3">
            <p className="mb-2 text-sm font-semibold">{t("adminExposure")}</p>
            {(d?.exposure || []).slice(0, 10).map((e) => (
              <div key={e.symbol} className="flex items-center justify-between border-t border-border/30 py-1 text-xs">
                <b>{e.symbol}</b>
                <span className="font-number text-muted-foreground">{e.lots} lots · {t("adminNotional")} {money(e.notionalUsd)}</span>
              </div>
            ))}
            {(d?.exposure || []).length === 0 && <p className="py-3 text-xs text-muted-foreground">{t("adminNoOpen")}</p>}
          </CardContent>
        </Card>
        <Card className="glass-panel border-border/50">
          <CardContent className="p-3">
            <p className="mb-2 text-sm font-semibold">{t("adminRecentTape")}</p>
            {(d?.recentTrades || []).slice(0, 10).map((tr: any) => (
              <div key={tr.id} className="flex items-center justify-between border-t border-border/30 py-1 text-xs">
                <span><b>{tr.traderName}</b> · {tr.symbol} {String(tr.side).toUpperCase()} {tr.lots}</span>
                <span className={cn("font-number font-semibold", (Number(tr.pnl) + Number(tr.swap)) >= 0 ? "text-emerald-400" : "text-red-400")}>
                  {(Number(tr.pnl) + Number(tr.swap)) >= 0 ? "+" : ""}${(Number(tr.pnl) + Number(tr.swap)).toFixed(2)}
                </span>
              </div>
            ))}
            {(d?.recentTrades || []).length === 0 && <p className="py-3 text-xs text-muted-foreground">{t("adminEmpty")}</p>}
          </CardContent>
        </Card>
      </div>
      <div className="space-y-2">
        {accounts.map((a) => (
          <div key={a.aid} className="rounded-xl border border-border/50 bg-card/50 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {a.traderName}
                <span className="text-xs font-normal text-muted-foreground">{a.challengeName || a.label} · {money(a.startingBalance)}</span>
                {a.flags.map((f) => (
                  <Badge key={f} variant="outline" className={cn("rounded-full text-[9px] font-bold uppercase",
                    f === "risk" || f === "failed" ? "border-red-500/40 text-red-400"
                      : f === "suspended" ? "border-amber-500/40 text-amber-400"
                        : "border-sky-500/40 text-sky-400")}>{flagLabel(f)}</Badge>
                ))}
              </span>
              <span className="font-number text-xs text-muted-foreground">
                {t("adminBalance")} {money(a.balance)} · {t("pfEquity")} {money(a.equity)} · <span className={a.floatingPnl >= 0 ? "text-emerald-400" : "text-red-400"}>{t("adminMonitorFloating")} {a.floatingPnl >= 0 ? "+" : ""}${a.floatingPnl.toFixed(2)}</span>
              </span>
            </div>
            {a.positions.length > 0 && (
              <p className="mt-1 font-number text-[11px] text-muted-foreground">
                {a.positions.map((p) => `${p.symbol} ${String(p.side).toUpperCase()} ${p.lots} (${money(p.notionalUsd)})`).join(" · ")}
              </p>
            )}
          </div>
        ))}
        {accounts.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t("adminNoOpen")}</p>}
      </div>
    </div>
  );
}

function AlertsSection() {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["admin-alerts"], queryFn: platformApi.alerts, refetchInterval: 30_000 });
  const markAll = useMutation({
    mutationFn: () => platformApi.markAlertsRead(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-alerts"] }),
  });
  const alerts = q.data?.alerts || [];
  const sev = (s: string) => (s === "critical" ? "border-red-500/40 text-red-400" : s === "warning" ? "border-amber-500/40 text-amber-400" : "border-border/50 text-muted-foreground");
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{q.data ? `${q.data.unread} ${t("adminUnread")}` : "…"}</span>
        <Button size="sm" variant="outline" className="h-8 rounded-full" disabled={markAll.isPending || !q.data?.unread} onClick={() => markAll.mutate()}>
          {t("adminMarkAllRead")}
        </Button>
      </div>
      {alerts.map((a) => (
        <div key={a.id} className={cn("rounded-xl border px-3 py-2 text-sm", a.read ? "border-border/40 bg-card/30 opacity-70" : sev(a.severity))}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{a.text}</span>
            <span className="text-[11px] text-muted-foreground">{a.type} · {new Date(a.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
          </div>
        </div>
      ))}
      {alerts.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t("adminNoAlerts")}</p>}
    </div>
  );
}

function PlatformSection() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const sQ = useQuery({ queryKey: ["admin-settings"], queryFn: platformApi.getSettings });
  const rQ = useQuery({ queryKey: ["admin-roles"], queryFn: platformApi.getRoles });
  const [form, setForm] = useState<PlatformSettingsShape | null>(null);
  const [roleUid, setRoleUid] = useState("");
  const [roleValue, setRoleValue] = useState("moderator");
  const s = form || sQ.data?.settings || null;

  const save = useMutation({
    mutationFn: () => platformApi.saveSettings(s!),
    onSuccess: () => {
      toast({ title: t("adminSettingsSaved") });
      queryClient.invalidateQueries({ queryKey: ["admin-settings"] });
    },
    onError: (e: any) => toast({ title: t("serverError"), description: String(e?.message || ""), variant: "destructive" }),
  });
  const setRole = useMutation({
    mutationFn: () => platformApi.setRole(roleUid.trim(), roleValue),
    onSuccess: () => {
      toast({ title: t("adminSetRole"), description: roleUid.trim() });
      setRoleUid("");
      queryClient.invalidateQueries({ queryKey: ["admin-roles"] });
    },
    onError: (e: any) => toast({ title: t("serverError"), description: String(e?.message || ""), variant: "destructive" }),
  });

  const numField = (label: string, key: keyof PlatformSettingsShape, step = "1") => (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground">{label}</label>
      <Input
        type="number" step={step}
        value={s && (s as any)[key] != null ? String((s as any)[key]) : ""}
        onChange={(e) => setForm({ ...(s as PlatformSettingsShape), [key]: e.target.value === "" ? null : Number(e.target.value) } as PlatformSettingsShape)}
        className="h-9 rounded-lg text-sm"
      />
    </div>
  );

  const dcField = (label: string, key: "profitTargetPct" | "dailyLossLimitPct" | "maxDrawdownPct" | "minTradingDays" | "maxTradingDays") => (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground">{label}</label>
      <Input
        type="number" step="1"
        value={s?.defaultChallenge && (s.defaultChallenge as any)[key] != null ? String((s.defaultChallenge as any)[key]) : ""}
        onChange={(e) => setForm({
          ...(s as PlatformSettingsShape),
          defaultChallenge: { ...(s as PlatformSettingsShape).defaultChallenge, [key]: e.target.value === "" ? null : Number(e.target.value) },
        })}
        className="h-9 rounded-lg text-sm"
      />
    </div>
  );

  return (
    <div className="space-y-4">
      <Card className="glass-panel border-border/50">
        <CardHeader className="pb-2"><CardTitle className="text-lg">{t("adminSettingsTitle")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {s && (
            <>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={s.maintenanceMode} onChange={(e) => setForm({ ...s, maintenanceMode: e.target.checked })} className="h-4 w-4" />
                  <span className={s.maintenanceMode ? "font-semibold text-amber-400" : ""}>{t("adminMaintenance")}</span>
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={s.registrationOpen} onChange={(e) => setForm({ ...s, registrationOpen: e.target.checked })} className="h-4 w-4" />
                  {t("adminRegistrationOpen")}
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">{t("adminSymbolsMode")}</label>
                  <Select value={s.symbolsMode} onValueChange={(v) => setForm({ ...s, symbolsMode: v as "all" | "custom" })}>
                    <SelectTrigger className="h-9 rounded-lg text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent className="glass-panel border-border/60">
                      <SelectItem value="all">all instruments</SelectItem>
                      <SelectItem value="custom">custom list</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">{t("adminCustomSymbols")}</label>
                  <Input value={s.customSymbols.join(", ")} onChange={(e) => setForm({ ...s, customSymbols: e.target.value.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) })} className="h-9 rounded-lg text-sm" />
                </div>
                {numField(t("adminDefaultBalance"), "defaultAccountBalance")}
                {numField(t("adminDefaultLeverage"), "defaultLeverage")}
                {numField(t("adminMaxLot"), "maxLotPerOrder", "0.01")}
                {numField(t("adminCommission"), "commissionPerLotUsd", "0.01")}
                {numField(t("adminSpreadMultiplier"), "spreadMultiplier", "0.1")}
                {dcField(t("adminTypeTarget"), "profitTargetPct")}
                {dcField(t("adminTypeDailyDd"), "dailyLossLimitPct")}
                {dcField(t("adminTypeMaxDd"), "maxDrawdownPct")}
                {dcField(t("adminTypeMinDays"), "minTradingDays")}
                {dcField(t("adminTypeMaxDays"), "maxTradingDays")}
              </div>
              <Button className="rounded-xl bg-sky-500 font-semibold text-white hover:bg-sky-400" disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{t("adminSaveSettings")}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="glass-panel border-border/50">
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-lg"><Trophy className="h-5 w-5 text-amber-400" />{t("adminRolesTitle")}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {(rQ.data?.roles || []).map((r) => (
            <div key={r.uid} className="flex items-center justify-between rounded-lg border border-border/40 bg-card/40 px-3 py-1.5 text-xs">
              <span className="font-semibold">{r.name || r.uid}</span>
              <Badge variant="outline" className="rounded-full border-primary/40 text-primary">{r.role}</Badge>
              <span className="font-mono text-[10px] text-muted-foreground">{r.uid.slice(0, 12)}…</span>
            </div>
          ))}
          {(rQ.data?.roles || []).length === 0 && <p className="text-xs text-muted-foreground">{t("adminNoRoles")}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <Input value={roleUid} onChange={(e) => setRoleUid(e.target.value)} placeholder={t("adminRoleTarget")} className="h-9 max-w-[280px] rounded-lg text-sm" />
            <Select value={roleValue} onValueChange={setRoleValue}>
              <SelectTrigger className="w-[150px] rounded-lg"><SelectValue /></SelectTrigger>
              <SelectContent className="glass-panel border-border/60">
                {["analyst", "moderator", "admin", "super_admin"].map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" className="h-9 rounded-lg" disabled={!roleUid.trim() || setRole.isPending} onClick={() => setRole.mutate()}>
              {t("adminSetRole")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function PlatformAdmin() {
  const { t } = useLanguage();
  return (
    <Tabs defaultValue="overview" className="w-full">
      <TabsList className="mb-4 flex h-auto flex-wrap gap-1.5 rounded-2xl bg-muted/50 p-1.5">
        <TabsTrigger value="overview" className="gap-1.5 rounded-full"><LayoutDashboard className="h-4 w-4" />{t("adminOverviewTab")}</TabsTrigger>
        <TabsTrigger value="users" className="gap-1.5 rounded-full"><Users className="h-4 w-4" />{t("adminUsersTab")}</TabsTrigger>
        <TabsTrigger value="monitor" className="gap-1.5 rounded-full"><Activity className="h-4 w-4" />{t("adminMonitorTab")}</TabsTrigger>
        <TabsTrigger value="alerts" className="gap-1.5 rounded-full"><BellRing className="h-4 w-4" />{t("adminAlertsTab")}</TabsTrigger>
        <TabsTrigger value="settings" className="gap-1.5 rounded-full"><Settings2 className="h-4 w-4" />{t("adminPlatformTab")}</TabsTrigger>
      </TabsList>
      <TabsContent value="overview"><OverviewSection /></TabsContent>
      <TabsContent value="users"><UsersSection /></TabsContent>
      <TabsContent value="monitor"><MonitorSection /></TabsContent>
      <TabsContent value="alerts"><AlertsSection /></TabsContent>
      <TabsContent value="settings"><PlatformSection /></TabsContent>
    </Tabs>
  );
}

/** Export one account's trade history as CSV (client-side generation). */
export function exportTradesCsv(trades: Record<string, unknown>[], aid: string) {
  const head = "tradeId,symbol,side,lots,entry,exit,pnl,swap,commission,reason,openedAt,closedAt";
  const rows = trades.map((t: any) => [
    t.id, t.symbol, t.side, t.lots, t.entry, t.exit, t.pnl, t.swap, t.commission ?? 0, t.reason,
    new Date(t.openedAt).toISOString(), new Date(t.closedAt).toISOString(),
  ].join(","));
  const csv = [head, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inspiretrade-${aid}-history.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

