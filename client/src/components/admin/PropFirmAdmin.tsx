/**
 * PropFirmAdmin — the admin "Prop Firm" tab: challenge type CRUD, account
 * assignment, trader monitoring, suspend/reactivate/reset actions, the
 * immutable audit log and the public leaderboard switch. All operations go
 * through /api/trading?action=admin-* (requireAdmin server-side); every
 * mutation is recorded in the server-side propAudit collection.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Briefcase, Plus, RefreshCw, Send, Trash2, PauseCircle, PlayCircle, RotateCcw, Eye,
  ShieldCheck, ListChecks, Trophy, X, CircleCheck, CircleX, Activity, Loader2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { propApi, type AdminAccountRow, type ChallengeTypeInfo, type AdminAuditEntry } from "@/lib/trading-api";
import { cn } from "@/lib/utils";

const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const SIZES = [5000, 10000, 25000, 50000, 100000];

const emptyForm = {
  name: "", size: "10000", profitTargetPct: "10", dailyLossLimitPct: "5", maxDrawdownPct: "10",
  minTradingDays: "3", maxTradingDays: "30", maxLotsPerOrder: "5", maxLotsTotal: "10",
  maxOpenPositions: "10", leverage: "100", active: true, description: "",
};

function StatusBadge({ row }: { row: AdminAccountRow }) {
  const map = row.adminSuspended
    ? { label: "suspended", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30", icon: PauseCircle }
    : row.status === "passed"
      ? { label: "passed", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", icon: CircleCheck }
      : row.status === "failed"
        ? { label: "failed", cls: "bg-red-500/15 text-red-400 border-red-500/30", icon: CircleX }
        : { label: "active", cls: "bg-primary/15 text-primary border-primary/30", icon: Activity };
  const Icon = map.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 rounded-full text-[10px] font-bold uppercase", map.cls)}>
      <Icon className="h-3 w-3" />{map.label}
    </Badge>
  );
}

export function PropFirmAdmin() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // challenge type form
  const [form, setForm] = useState({ ...emptyForm });
  const [editId, setEditId] = useState<string | null>(null);
  // assignment
  const [assignTarget, setAssignTarget] = useState("");
  const [assignTypeId, setAssignTypeId] = useState("");
  // monitoring
  const [statusFilter, setStatusFilter] = useState("all");
  const [detail, setDetail] = useState<{ uid: string; aid: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState<AdminAccountRow | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-pf-types"] });
    queryClient.invalidateQueries({ queryKey: ["admin-pf-accounts"] });
    queryClient.invalidateQueries({ queryKey: ["admin-pf-audit"] });
    queryClient.invalidateQueries({ queryKey: ["admin-pf-detail"] });
    queryClient.invalidateQueries({ queryKey: ["admin-pf-settings"] });
  };

  const typesQ = useQuery({ queryKey: ["admin-pf-types"], queryFn: propApi.adminListChallengeTypes });
  const accountsQ = useQuery({
    queryKey: ["admin-pf-accounts", statusFilter],
    queryFn: () => propApi.adminListAccounts(statusFilter),
    refetchInterval: 30_000,
  });
  const auditQ = useQuery({ queryKey: ["admin-pf-audit"], queryFn: () => propApi.adminAudit() });
  const settingsQ = useQuery({
    queryKey: ["admin-pf-settings"],
    queryFn: async () => {
      // settings read goes through the types endpoint? No — dedicated toggle state lives
      // server-side; the cheapest read is the public leaderboard's enabled flag
      const res = await propApi.getLeaderboard("all");
      return res.enabled;
    },
  });
  const detailQ = useQuery({
    queryKey: ["admin-pf-detail", detail?.uid, detail?.aid],
    queryFn: () => propApi.adminAccountDetail(detail!.uid, detail!.aid),
    enabled: !!detail,
  });

  const err = (e: any) => toast({ title: t("serverError"), description: String(e?.message || ""), variant: "destructive" });

  const saveType = useMutation({
    mutationFn: () => propApi.adminSaveChallengeType({
      ...(editId ? { id: editId } : {}),
      name: form.name.trim(),
      size: Number(form.size),
      profitTargetPct: form.profitTargetPct === "" ? null : Number(form.profitTargetPct),
      dailyLossLimitPct: form.dailyLossLimitPct === "" ? null : Number(form.dailyLossLimitPct),
      maxDrawdownPct: form.maxDrawdownPct === "" ? null : Number(form.maxDrawdownPct),
      minTradingDays: Number(form.minTradingDays) || 0,
      maxTradingDays: form.maxTradingDays === "" || Number(form.maxTradingDays) === 0 ? null : Number(form.maxTradingDays),
      maxLotsPerOrder: form.maxLotsPerOrder === "" ? null : Number(form.maxLotsPerOrder),
      maxLotsTotal: form.maxLotsTotal === "" ? null : Number(form.maxLotsTotal),
      maxOpenPositions: form.maxOpenPositions === "" ? null : Number(form.maxOpenPositions),
      leverage: Number(form.leverage),
      active: form.active,
      description: form.description.trim(),
    }),
    onSuccess: () => {
      toast({ title: t("adminTypeSaved") });
      setForm({ ...emptyForm }); setEditId(null); invalidate();
    },
    onError: err,
  });

  const deleteType = useMutation({
    mutationFn: (id: string) => propApi.adminDeleteChallengeType(id),
    onSuccess: () => { toast({ title: t("adminTypeDeleted") }); invalidate(); },
    onError: err,
  });

  const assign = useMutation({
    mutationFn: () => propApi.adminAssignAccount({
      target: assignTarget.trim(),
      typeId: assignTypeId,
    }),
    onSuccess: () => {
      toast({ title: t("adminAssigned"), description: assignTarget.trim() });
      setAssignTarget(""); invalidate();
    },
    onError: err,
  });

  const accountAction = useMutation({
    mutationFn: ({ uid, aid, action }: { uid: string; aid: string; action: "suspend" | "reactivate" | "reset" }) =>
      propApi.adminAccountAction(uid, aid, action),
    onSuccess: (_d, v) => {
      toast({ title: v.action === "suspend" ? t("adminSuspendedDone") : v.action === "reset" ? t("adminResetDone") : t("adminReactivatedDone") });
      setConfirmReset(null); invalidate();
    },
    onError: err,
  });

  const toggleLeaderboard = useMutation({
    mutationFn: (enabled: boolean) => propApi.adminLeaderboardToggle(enabled),
    onSuccess: () => invalidate(),
    onError: err,
  });

  const startEdit = (ty: ChallengeTypeInfo) => {
    setEditId(ty.id);
    setForm({
      name: ty.name,
      size: String(ty.size),
      profitTargetPct: ty.profitTargetPct == null ? "" : String(ty.profitTargetPct),
      dailyLossLimitPct: ty.dailyLossLimitPct == null ? "" : String(ty.dailyLossLimitPct),
      maxDrawdownPct: ty.maxDrawdownPct == null ? "" : String(ty.maxDrawdownPct),
      minTradingDays: String(ty.minTradingDays),
      maxTradingDays: ty.maxTradingDays == null ? "0" : String(ty.maxTradingDays),
      maxLotsPerOrder: ty.maxLotsPerOrder == null ? "" : String(ty.maxLotsPerOrder),
      maxLotsTotal: ty.maxLotsTotal == null ? "" : String(ty.maxLotsTotal),
      maxOpenPositions: ty.maxOpenPositions == null ? "" : String(ty.maxOpenPositions),
      leverage: String(ty.leverage),
      active: ty.active !== false,
      description: ty.description || "",
    });
  };

  const field = (label: string, key: keyof typeof emptyForm, opts: { type?: string; placeholder?: string } = {}) => (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground">{label}</label>
      <Input
        type={opts.type || "number"}
        value={form[key] as string}
        placeholder={opts.placeholder}
        onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
        className="h-9 rounded-lg text-sm"
      />
    </div>
  );

  const accounts = accountsQ.data || [];
  const types = typesQ.data || [];
  const audit: AdminAuditEntry[] = auditQ.data || [];
  const d = detailQ.data;

  return (
    <div className="space-y-5">
      <p className="text-xs leading-relaxed text-muted-foreground">{t("adminPropHint")}</p>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* ---- challenge type editor ---- */}
        <Card className="glass-panel border-sky-500/30">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Plus className="h-5 w-5 text-sky-400" />
              {editId ? `${t("adminTypeListTitle")} — ${t("adminTypeSave")}` : t("adminTypeCreateTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">{t("adminTypeName")}</label>
                <Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value.slice(0, 60) }))} placeholder="10K Standard" className="h-9 rounded-lg text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">{t("adminTypeSize")}</label>
                <Select value={form.size} onValueChange={(v) => setForm((p) => ({ ...p, size: v }))}>
                  <SelectTrigger className="h-9 rounded-lg text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent className="glass-panel border-border/60">
                    {SIZES.map((s) => <SelectItem key={s} value={String(s)}>{money(s)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {field(t("adminTypeTarget"), "profitTargetPct")}
              {field(t("adminTypeDailyDd"), "dailyLossLimitPct")}
              {field(t("adminTypeMaxDd"), "maxDrawdownPct")}
              {field(t("adminTypeMinDays"), "minTradingDays")}
              {field(t("adminTypeMaxDays"), "maxTradingDays")}
              {field(t("adminTypeMaxLot"), "maxLotsPerOrder", { type: "number", placeholder: "—" })}
              {field(t("adminTypeMaxLots"), "maxLotsTotal", { type: "number", placeholder: "—" })}
              {field(t("adminTypeMaxPos"), "maxOpenPositions", { type: "number", placeholder: "—" })}
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">{t("adminTypeLeverage")}</label>
                <Select value={form.leverage} onValueChange={(v) => setForm((p) => ({ ...p, leverage: v }))}>
                  <SelectTrigger className="h-9 rounded-lg text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent className="glass-panel border-border/60">
                    {[10, 20, 30, 50, 100, 200, 500].map((l) => <SelectItem key={l} value={String(l)}>1:{l}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm((p) => ({ ...p, active: e.target.checked }))} className="h-4 w-4 rounded" />
              {t("adminTypeActive")}
            </label>
            <div className="flex gap-2">
              <Button
                size="lg" className="flex-1 rounded-xl bg-sky-500 font-semibold text-white hover:bg-sky-400"
                disabled={saveType.isPending || form.name.trim().length < 2}
                onClick={() => saveType.mutate()}
              >
                {saveType.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                {editId ? t("adminTypeSave") : t("adminTypeCreateTitle")}
              </Button>
              {editId && (
                <Button variant="outline" size="lg" className="rounded-xl" onClick={() => { setEditId(null); setForm({ ...emptyForm }); }}>
                  <X className="h-4 w-4" />{t("adminClose")}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          {/* ---- existing types ---- */}
          <Card className="glass-panel border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-lg">
                <span className="flex items-center gap-2"><Briefcase className="h-5 w-5 text-primary" />{t("adminTypeListTitle")}</span>
                <Button variant="outline" size="sm" className="h-8 gap-1.5 rounded-full" onClick={() => { queryClient.invalidateQueries({ queryKey: ["admin-pf-types"] }); queryClient.invalidateQueries({ queryKey: ["admin-pf-accounts"] }); }}>
                  <RefreshCw className="h-3.5 w-3.5" />{t("pfRefresh")}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {types.length === 0 && <p className="py-2 text-center text-sm text-muted-foreground">{t("adminNoTypes")}</p>}
              {types.map((ty) => (
                <div key={ty.id} className="rounded-xl border border-border/50 bg-card/50 px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-semibold">
                        {ty.name}
                        {!ty.active && <Badge variant="outline" className="rounded-full border-red-500/40 text-[9px] text-red-400">off</Badge>}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {money(ty.size)} · target {ty.profitTargetPct ?? "—"}% · daily {ty.dailyLossLimitPct ?? "—"}% · max {ty.maxDrawdownPct ?? "—"}% · {ty.minTradingDays}-{ty.maxTradingDays ?? "∞"}d · {ty.maxLotsPerOrder ?? "—"} lot · 1:{ty.leverage}
                      </p>
                    </div>
                    <div className="flex gap-1.5">
                      <Button variant="outline" size="sm" className="h-8 rounded-full" onClick={() => startEdit(ty)}>{t("adminView")}</Button>
                      <Button variant="outline" size="sm" className="h-8 rounded-full text-red-400 hover:text-red-300" disabled={deleteType.isPending} onClick={() => deleteType.mutate(ty.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* ---- assignment ---- */}
          <Card className="glass-panel border-amber-500/30">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg"><Send className="h-5 w-5 text-amber-400" />{t("adminAssignTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">{t("adminAssignTarget")}</label>
                <Input value={assignTarget} onChange={(e) => setAssignTarget(e.target.value)} placeholder="@username or uid" className="h-11 rounded-xl" />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">{t("adminAssignType")}</label>
                <Select value={assignTypeId} onValueChange={setAssignTypeId}>
                  <SelectTrigger className="w-full rounded-xl"><SelectValue placeholder={t("adminAssignType")} /></SelectTrigger>
                  <SelectContent className="glass-panel border-border/60">
                    {types.filter((ty) => ty.active !== false).map((ty) => (
                      <SelectItem key={ty.id} value={ty.id}>{ty.name} — {money(ty.size)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                size="lg" className="w-full rounded-xl bg-gradient-to-r from-amber-500 to-yellow-400 font-semibold text-black hover:from-amber-400 hover:to-yellow-300"
                disabled={assign.isPending || !assignTarget.trim() || !assignTypeId}
                onClick={() => assign.mutate()}
              >
                <Send className="mr-2 h-4 w-4" />{t("adminAssignBtn")}
              </Button>
            </CardContent>
          </Card>

          {/* ---- leaderboard switch ---- */}
          <Card className="glass-panel border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg"><Trophy className="h-5 w-5 text-amber-400" />{t("adminLeaderboardToggle")}</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between">
              <Badge variant="outline" className={cn("rounded-full text-[10px] font-bold uppercase", settingsQ.data ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-red-500/15 text-red-400 border-red-500/30")}>
                {settingsQ.data ? t("adminEnabled") : t("adminDisabled")}
              </Badge>
              <div className="flex gap-2">
                <Button size="sm" className="h-8 rounded-full bg-emerald-600 text-white hover:bg-emerald-500" disabled={toggleLeaderboard.isPending || !!settingsQ.data} onClick={() => toggleLeaderboard.mutate(true)}>
                  {t("adminEnabled")}
                </Button>
                <Button size="sm" variant="outline" className="h-8 rounded-full border-red-500/40 text-red-400" disabled={toggleLeaderboard.isPending || settingsQ.data === false} onClick={() => toggleLeaderboard.mutate(false)}>
                  {t("adminDisabled")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ---- trader monitoring ---- */}
      <Card className="glass-panel border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-lg">
            <span className="flex items-center gap-2"><Activity className="h-5 w-5 text-primary" />{t("adminMonitorTitle")}</span>
            <div className="flex flex-wrap gap-1.5">
              {(["all", "active", "passed", "failed", "suspended"] as const).map((s) => (
                <button
                  key={s} onClick={() => setStatusFilter(s)}
                  className={cn(
                    "rounded-full px-3 py-1 text-[11px] transition-colors",
                    statusFilter === s ? "bg-primary/15 font-semibold text-primary" : "text-muted-foreground hover:bg-accent/50",
                  )}
                >
                  {s === "all" ? t("adminFilterAll") : s === "active" ? t("adminFilterActive") : s === "passed" ? t("adminFilterPassed") : s === "failed" ? t("adminFilterFailed") : t("adminFilterSuspended")}
                </button>
              ))}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {accounts.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">—</p>}
          {accounts.map((row) => (
            <div key={row.aid} className="rounded-xl border border-border/50 bg-card/50 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {row.traderName}
                    <span className="text-xs font-normal text-muted-foreground">{row.challengeName || row.label} · {money(row.startingBalance)}</span>
                    <StatusBadge row={row} />
                  </p>
                  <p className="font-number text-[11px] text-muted-foreground">
                    {t("adminBalance")}: {money(row.balance)} · {t("adminProfit")}: <span className={row.profitPct >= 0 ? "text-emerald-400" : "text-red-400"}>{row.profitPct >= 0 ? "+" : ""}{row.profitPct}%</span>
                    {" · "}{t("adminTrades")}: {row.stats?.totalTrades ?? 0}
                    {row.stats?.totalTrades ? ` · win ${Math.round(((row.stats.wins || 0) / row.stats.totalTrades) * 1000) / 10}%` : ""}
                    {" · "}{t("pfTradingDays")}: {row.tradingDays}
                    {row.failedReason ? ` · ${row.failedReason}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button variant="outline" size="sm" className="h-8 gap-1 rounded-full" onClick={() => setDetail({ uid: row.uid, aid: row.aid })}>
                    <Eye className="h-3.5 w-3.5" />{t("adminView")}
                  </Button>
                  {!row.adminSuspended && row.status === "active" && (
                    <Button variant="outline" size="sm" className="h-8 gap-1 rounded-full border-amber-500/40 text-amber-400" disabled={accountAction.isPending} onClick={() => accountAction.mutate({ uid: row.uid, aid: row.aid, action: "suspend" })}>
                      <PauseCircle className="h-3.5 w-3.5" />{t("adminSuspend")}
                    </Button>
                  )}
                  {row.adminSuspended && (
                    <Button variant="outline" size="sm" className="h-8 gap-1 rounded-full border-emerald-500/40 text-emerald-400" disabled={accountAction.isPending} onClick={() => accountAction.mutate({ uid: row.uid, aid: row.aid, action: "reactivate" })}>
                      <PlayCircle className="h-3.5 w-3.5" />{t("adminReactivate")}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" className="h-8 gap-1 rounded-full border-red-500/40 text-red-400" disabled={accountAction.isPending} onClick={() => setConfirmReset(row)}>
                    <RotateCcw className="h-3.5 w-3.5" />{t("adminReset")}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ---- account detail ---- */}
      {detail && (
        <Card className="glass-panel border-primary/30">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-lg">
              <span className="flex items-center gap-2"><ListChecks className="h-5 w-5 text-primary" />{detailQ.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{d ? `${d.traderName} — ${d.account.challengeName || d.account.label}` : ""}</span>
              <Button variant="outline" size="sm" className="h-8 gap-1 rounded-full" onClick={() => setDetail(null)}><X className="h-3.5 w-3.5" />{t("adminClose")}</Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {d && (
              <>
                <div className="flex flex-wrap gap-1.5 text-xs">
                  <span className="rounded-lg border border-border/50 bg-card/60 px-2 py-1">{t("adminBalance")}: <b className="font-number">{money(d.account.balance)}</b></span>
                  <span className="rounded-lg border border-border/50 bg-card/60 px-2 py-1">{t("pfEquity")}: <b className="font-number">{money(d.metrics.equity)}</b></span>
                  <span className="rounded-lg border border-border/50 bg-card/60 px-2 py-1">{t("adminProfit")}: <b className={cn("font-number", d.metrics.equity >= d.account.startingBalance ? "text-emerald-400" : "text-red-400")}>{d.metrics.equity >= d.account.startingBalance ? "+" : ""}{money(d.metrics.equity - d.account.startingBalance)}</b></span>
                  <span className="rounded-lg border border-border/50 bg-card/60 px-2 py-1">{t("adminTrades")}: <b className="font-number">{d.account.stats?.totalTrades ?? 0}</b></span>
                  <span className="rounded-lg border border-border/50 bg-card/60 px-2 py-1">{t("adminPositions")}: <b className="font-number">{d.positions.length}</b></span>
                  <span className="rounded-lg border border-border/50 bg-card/60 px-2 py-1">{t("adminPendingOrders")}: <b className="font-number">{d.orders.length}</b></span>
                </div>
                {d.account.rules && (
                  <p className="font-number text-[11px] text-muted-foreground">
                    {t("pfRules")}: target {d.account.rules.profitTargetPct ?? "—"}% · daily {d.account.rules.dailyLossLimitPct ?? "—"}% · max {d.account.rules.maxDrawdownPct ?? "—"}% · {d.account.rules.minTradingDays}+d · ≤{d.account.rules.maxTradingDays ?? "∞"}d · ≤{d.account.rules.maxLotsPerOrder ?? "—"} lot · ≤{d.account.rules.maxOpenPositions ?? "—"} pos · 1:{d.account.leverage}
                  </p>
                )}
                {d.trades.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[420px] text-left text-xs">
                      <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        <tr><th className="pb-1 pr-3">{t("pfSymbol")}</th><th className="pb-1 pr-3">{t("pfSide")}</th><th className="pb-1 pr-3">{t("pfLots")}</th><th className="pb-1 pr-3">{t("pfPnl")}</th><th className="pb-1">{t("pfClosed")}</th></tr>
                      </thead>
                      <tbody className="font-number">
                        {d.trades.slice(0, 12).map((tr: any) => (
                          <tr key={tr.id} className="border-t border-border/40">
                            <td className="py-1 pr-3 font-semibold">{tr.symbol}</td>
                            <td className={cn("py-1 pr-3 uppercase", tr.side === "buy" ? "text-emerald-400" : "text-red-400")}>{tr.side}</td>
                            <td className="py-1 pr-3">{tr.lots}</td>
                            <td className={cn("py-1 pr-3 font-semibold", (tr.pnl + tr.swap) >= 0 ? "text-emerald-400" : "text-red-400")}>{(tr.pnl + tr.swap) >= 0 ? "+" : ""}${(tr.pnl + tr.swap).toFixed(2)}</td>
                            <td className="py-1 text-muted-foreground">{new Date(tr.closedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* ---- reset confirmation ---- */}
      {confirmReset && (
        <Card className="glass-panel border-red-500/40">
          <CardContent className="space-y-3 p-4">
            <p className="text-sm">
              <ShieldCheck className="mr-1.5 inline h-4 w-4 text-red-400" />
              {t("adminReset")} — {confirmReset.traderName} ({confirmReset.challengeName || confirmReset.label}, {money(confirmReset.startingBalance)})?
            </p>
            <div className="flex gap-2">
              <Button size="sm" className="rounded-full bg-red-600 text-white hover:bg-red-500" disabled={accountAction.isPending}
                onClick={() => accountAction.mutate({ uid: confirmReset.uid, aid: confirmReset.aid, action: "reset" })}>
                {t("adminReset")}
              </Button>
              <Button size="sm" variant="outline" className="rounded-full" onClick={() => setConfirmReset(null)}>{t("adminClose")}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---- audit log ---- */}
      <Card className="glass-panel border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-lg">
            <span className="flex items-center gap-2"><ListChecks className="h-5 w-5 text-muted-foreground" />{t("adminAuditTitle")}</span>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 rounded-full" onClick={() => queryClient.invalidateQueries({ queryKey: ["admin-pf-audit"] })}>
              <RefreshCw className="h-3.5 w-3.5" />{t("pfRefresh")}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {audit.length === 0 && <p className="py-2 text-center text-sm text-muted-foreground">—</p>}
          {audit.slice(0, 30).map((e) => (
            <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/40 bg-card/40 px-3 py-1.5 text-xs">
              <span className="font-semibold">{e.action}</span>
              <span className="text-muted-foreground">
                {e.name ? e.name : ""}{e.uid ? ` · ${e.uid.slice(0, 8)}…` : ""}{typeof e.closed === "number" ? ` · ${e.closed} closed` : ""}{typeof e.enabled === "boolean" ? ` · ${e.enabled ? "on" : "off"}` : ""}
              </span>
              <span className="text-muted-foreground">{e.by}</span>
              <span className="text-muted-foreground">{new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
