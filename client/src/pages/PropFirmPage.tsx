import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, ArrowRight, BarChart3, ChevronDown, LockKeyhole, Wallet, RefreshCw,
  CircleCheck, CircleX, PauseCircle, Activity, Target, ShieldAlert, TrendingUp, Scale,
} from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  tradingApi, propApi,
  type ChallengeTypeInfo, type ServerAccount, type ServerTrade,
} from "@/lib/trading-api";
import { useLanguage } from "@/lib/language-context";
import { CustomAccountBuilder } from "@/components/prop/CustomAccountBuilder";
import { cn } from "@/lib/utils";

type Phase6Type = {
  id: string;
  name: string;
  size: number;
  target: number | null;
  dailyDd: number | null;
  maxDd: number | null;
  minDays: number;
  maxDays: number | null;
  maxLotsPerOrder: number | null;
  maxLotsTotal: number | null;
  maxOpenPositions: number | null;
  leverage: number;
  description: string;
  demo?: boolean;
};

// Fallback shown to signed-out visitors — real formats come from the server
// (admin-configured challenge types) once authenticated.
const DEMO_TYPES: Phase6Type[] = [5000, 10000, 25000, 50000, 100000, 200000].map((size) => ({
  id: `demo-${size}`,
  name: `${size / 1000}K Challenge`,
  size,
  target: 10,
  dailyDd: 5,
  maxDd: 10,
  minDays: 3,
  maxDays: 30,
  maxLotsPerOrder: 5,
  maxLotsTotal: 10,
  maxOpenPositions: 10,
  leverage: 100,
  description: "",
  demo: true,
}));

const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const money2 = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5 rounded-lg border border-border/50 bg-card/60 px-2 py-1 text-xs">
      <span className="truncate text-muted-foreground">{label}</span>
      <span className="font-semibold text-foreground">{value}</span>
    </span>
  );
}

function DemoLine() {
  return (
    <p className="mb-5 text-xs text-muted-foreground">
      <span className="font-semibold text-amber-400">Demo only</span> — sample challenges and prices, not real offers. Purchases are coming soon.
    </p>
  );
}

/** Progress fill bar for target / drawdown gauges (value 0..1+). */
function FillBar({ value, tone }: { value: number; tone: "primary" | "amber" | "red" }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const bg = tone === "primary" ? "bg-primary" : tone === "amber" ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
      <div className={cn("h-full rounded-full transition-all", bg)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Server-trades → cumulative equity curve for the performance chart. */
function equityCurve(starting: number, trades: ServerTrade[]) {
  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  let eq = starting;
  const pts: { i: number; equity: number; label: string }[] = [{ i: 0, equity: Math.round(starting * 100) / 100, label: "start" }];
  sorted.forEach((t, idx) => {
    eq = Math.round((eq + t.pnl + t.swap) * 100) / 100;
    pts.push({ i: idx + 1, equity: eq, label: t.symbol });
  });
  return pts;
}

function StatusBadge({ account, t }: { account: ServerAccount; t: (k: string) => string }) {
  const map: Record<string, { label: string; cls: string; icon: any }> = {
    active: { label: t("pfActive"), cls: "bg-primary/15 text-primary border-primary/30", icon: Activity },
    passed: { label: t("pfPassed"), cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", icon: CircleCheck },
    failed: { label: t("pfFailed"), cls: "bg-red-500/15 text-red-400 border-red-500/30", icon: CircleX },
  };
  const suspended = { label: t("pfSuspended"), cls: "bg-amber-500/15 text-amber-400 border-amber-500/30", icon: PauseCircle };
  const s = account.adminSuspended ? suspended : (map[account.status] || map.active);
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide", s.cls)}>
      <Icon className="h-3.5 w-3.5" />{s.label}
    </span>
  );
}

/** One challenge account — the full monitoring dashboard. */
function ChallengeDashboard({ account, t }: { account: ServerAccount; t: (k: string) => string }) {
  const queryClient = useQueryClient();
  const rules = account.rules;
  const rs = account.ruleState;
  const metrics = account.metrics;
  const stats = account.stats || { totalTrades: 0, wins: 0, losses: 0 };
  const winRate = stats.totalTrades > 0 ? Math.round((stats.wins / stats.totalTrades) * 1000) / 10 : null;
  const profit = Math.round((metrics.equity - account.startingBalance) * 100) / 100;

  const historyQ = useQuery({
    queryKey: ["pf-history", account.id],
    queryFn: () => tradingApi.getHistory(account.id, 200),
  });
  const trades = historyQ.data || [];
  const curve = useMemo(() => equityCurve(account.startingBalance, trades), [account.startingBalance, trades]);
  const recent = useMemo(() => [...trades].sort((a, b) => b.closedAt - a.closedAt).slice(0, 8), [trades]);

  const refresh = useMutation({
    mutationFn: async () => {
      await tradingApi.evaluate(account.id).catch(() => {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pf-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["pf-history", account.id] });
    },
  });

  const dailyRemaining = rs && rs.dailyLossLimitUsd != null ? Math.max(0, rs.dailyLossLimitUsd - rs.dailyLossUsd) : null;
  const maxRemaining = rs && rs.maxDrawdownUsd != null ? Math.max(0, rs.maxDrawdownUsd - rs.drawdownUsd) : null;
  const targetUsd = rs?.targetUsd ?? null;

  return (
    <div className="space-y-4">
      {/* banners */}
      {account.adminSuspended && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          <PauseCircle className="h-4 w-4 shrink-0" />{t("pfSuspendedBanner")}
        </div>
      )}
      {account.status === "failed" && !account.adminSuspended && (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <ShieldAlert className="h-4 w-4 shrink-0" /><span><b>{t("pfFailedBanner")}</b>{account.failedReason ? ` — ${account.failedReason}` : ""}</span>
        </div>
      )}
      {account.status === "passed" && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          <CircleCheck className="h-4 w-4 shrink-0" />{t("pfPassedBanner")}
        </div>
      )}

      {/* headline stats */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        <Card className="border-border/60 bg-card/60"><CardContent className="p-3">
          <p className="text-[11px] text-muted-foreground">{t("pfStartingBalance")}</p>
          <p className="font-number text-lg font-bold">{money2(account.startingBalance)}</p>
        </CardContent></Card>
        <Card className="border-border/60 bg-card/60"><CardContent className="p-3">
          <p className="text-[11px] text-muted-foreground">{t("pfCurrentBalance")}</p>
          <p className="font-number text-lg font-bold">{money2(account.balance)}</p>
        </CardContent></Card>
        <Card className="border-border/60 bg-card/60"><CardContent className="p-3">
          <p className="text-[11px] text-muted-foreground">{t("pfEquity")}</p>
          <p className="font-number text-lg font-bold">{money2(metrics.equity)}</p>
          {metrics.floatingPnl !== 0 && (
            <p className={cn("text-[11px] font-semibold", metrics.floatingPnl > 0 ? "text-emerald-400" : "text-red-400")}>
              {metrics.floatingPnl > 0 ? "+" : ""}{money2(metrics.floatingPnl)} {t("pfPnl")}
            </p>
          )}
        </CardContent></Card>
        <Card className="border-border/60 bg-card/60"><CardContent className="p-3">
          <p className="text-[11px] text-muted-foreground">{t("pfTotalProfit")}</p>
          <p className={cn("font-number text-lg font-bold", profit > 0 ? "text-emerald-400" : profit < 0 ? "text-red-400" : "")}>
            {profit > 0 ? "+" : ""}{money2(profit)}
          </p>
          <p className="text-[11px] text-muted-foreground">{account.startingBalance > 0 ? `${Math.round((profit / account.startingBalance) * 10000) / 100}%` : "—"}</p>
        </CardContent></Card>
      </div>

      {/* progress gauges */}
      <div className="grid gap-2.5 sm:grid-cols-3">
        <Card className="border-border/60 bg-card/60"><CardContent className="space-y-2 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground"><Target className="h-3.5 w-3.5 text-primary" />{t("pfTargetProgress")}</span>
            <span className="font-number font-semibold">{targetUsd != null ? `${Math.round((rs?.targetProgress ?? 0) * 100)}%` : "—"}</span>
          </div>
          <FillBar value={rs?.targetProgress ?? 0} tone="primary" />
          <p className="text-[11px] text-muted-foreground">{targetUsd != null ? `${money2(account.startingBalance + targetUsd)} · +${money2(targetUsd)}` : "—"}</p>
        </CardContent></Card>
        <Card className="border-border/60 bg-card/60"><CardContent className="space-y-2 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground"><ShieldAlert className="h-3.5 w-3.5 text-amber-400" />{t("pfDailyDdRemaining")}</span>
            <span className="font-number font-semibold">{dailyRemaining != null ? money2(dailyRemaining) : "—"}</span>
          </div>
          <FillBar value={rs?.dailyLossUsed ?? 0} tone="amber" />
          <p className="text-[11px] text-muted-foreground">{rs?.dailyLossLimitUsd != null ? `-${money2(rs.dailyLossUsd)} / -${money2(rs.dailyLossLimitUsd)}` : "—"}</p>
        </CardContent></Card>
        <Card className="border-border/60 bg-card/60"><CardContent className="space-y-2 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground"><Scale className="h-3.5 w-3.5 text-red-400" />{t("pfMaxDdRemaining")}</span>
            <span className="font-number font-semibold">{maxRemaining != null ? money2(maxRemaining) : "—"}</span>
          </div>
          <FillBar value={rs?.drawdownUsed ?? 0} tone="red" />
          <p className="text-[11px] text-muted-foreground">{rs?.maxDrawdownUsd != null ? `-${money2(rs.drawdownUsd)} / -${money2(rs.maxDrawdownUsd)}` : "—"}</p>
        </CardContent></Card>
      </div>

      {/* secondary stats */}
      <div className="flex flex-wrap gap-1.5">
        <StatChip label={t("pfTradingDays")} value={`${account.tradingDays}${rules?.minTradingDays ? ` / ${rules.minTradingDays}` : ""}`} />
        <StatChip label={t("pfTotalTrades")} value={String(stats.totalTrades)} />
        <StatChip label={t("pfWinRate")} value={winRate != null ? `${winRate}%` : "—"} />
        <StatChip label={t("pfLeverage")} value={`1:${account.leverage}`} />
        {rules?.maxLotsPerOrder != null && <StatChip label={t("pfMaxLot")} value={String(rules.maxLotsPerOrder)} />}
        {rules?.maxLotsTotal != null && <StatChip label={t("pfMaxLots")} value={String(rules.maxLotsTotal)} />}
        {rules?.maxOpenPositions != null && <StatChip label={t("pfMaxPos")} value={String(rules.maxOpenPositions)} />}
        <StatChip label={t("adminPositions")} value={String(metrics.openCount)} />
        <StatChip label={t("pfStatus")} value={account.adminSuspended ? t("pfSuspended") : account.status} />
      </div>

      {/* equity curve */}
      <Card className="border-border/60 bg-card/60">
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="flex items-center gap-2 text-sm font-semibold"><TrendingUp className="h-4 w-4 text-primary" />{t("pfEquityCurve")}</p>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 rounded-full" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
              <RefreshCw className={cn("h-3.5 w-3.5", refresh.isPending && "animate-spin")} />{t("pfRefresh")}
            </Button>
          </div>
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={curve} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="pfEquityFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="i" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                <YAxis
                  domain={["auto", "auto"]} width={56}
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false}
                  tickFormatter={(v: number) => `$${Math.round(v).toLocaleString("en-US")}`}
                />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, fontSize: 12 }}
                  formatter={(v: any) => [`$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, t("pfEquity")]}
                  labelFormatter={(l: any) => (l === 0 ? "start" : `#${l}`)}
                />
                <Area type="monotone" dataKey="equity" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#pfEquityFill)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* recent trades */}
      <Card className="border-border/60 bg-card/60">
        <CardContent className="p-4">
          <p className="mb-2 text-sm font-semibold">{t("pfRecentTrades")}</p>
          {recent.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted-foreground">—</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="pb-1.5 pr-3">{t("pfSymbol")}</th>
                    <th className="pb-1.5 pr-3">{t("pfSide")}</th>
                    <th className="pb-1.5 pr-3">{t("pfLots")}</th>
                    <th className="pb-1.5 pr-3">{t("pfPnl")}</th>
                    <th className="pb-1.5">{t("pfClosed")}</th>
                  </tr>
                </thead>
                <tbody className="font-number">
                  {recent.map((tr) => (
                    <tr key={tr.id} className="border-t border-border/40">
                      <td className="py-1.5 pr-3 font-semibold">{tr.symbol}</td>
                      <td className={cn("py-1.5 pr-3 font-medium uppercase", tr.side === "buy" ? "text-emerald-400" : "text-red-400")}>{tr.side}</td>
                      <td className="py-1.5 pr-3">{tr.lots}</td>
                      <td className={cn("py-1.5 pr-3 font-semibold", tr.pnl + tr.swap >= 0 ? "text-emerald-400" : "text-red-400")}>
                        {tr.pnl + tr.swap >= 0 ? "+" : ""}{money2(tr.pnl + tr.swap)}
                      </td>
                      <td className="py-1.5 text-muted-foreground">{new Date(tr.closedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TypeCard({ item, onDetails }: { item: Phase6Type; onDetails: () => void }) {
  return (
    <Card className="group border-border/60 bg-background/60 transition-colors hover:border-primary/40">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">{item.name}</span>
          <span className="text-xs text-muted-foreground">1:{item.leverage}</span>
        </div>
        <h3 className="mt-2 text-2xl font-semibold tracking-tight">{money(item.size)} <span className="text-sm font-normal text-muted-foreground">account</span></h3>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <StatChip label="Target" value={item.target != null ? `${item.target}%` : "—"} />
          <StatChip label="Max DD" value={item.maxDd != null ? `${item.maxDd}%` : "—"} />
          <StatChip label="Daily DD" value={item.dailyDd != null ? `${item.dailyDd}%` : "—"} />
          <StatChip label="Min days" value={String(item.minDays)} />
        </div>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" className="flex-1 border-border" onClick={onDetails}>Rules <ArrowRight className="h-4 w-4" /></Button>
          {item.demo && (
            <Button className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90" disabled title="Purchases are not available yet">
              <LockKeyhole className="h-4 w-4" />Soon
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function TypeDetails({ item, onBack }: { item: Phase6Type; onBack: () => void }) {
  const rules: [string, string][] = [
    ["Risk management", `Daily loss limit ${item.dailyDd != null ? `${item.dailyDd}%` : "—"}, total loss limit ${item.maxDd != null ? `${item.maxDd}%` : "—"}.`],
    ["Trading period", item.maxDays ? `${item.maxDays}-day period, minimum ${item.minDays} trading days.` : "No time limit, minimum trading days may apply."],
    ["Volume & exposure", `Max ${item.maxLotsPerOrder ?? "—"} lots per order, ${item.maxLotsTotal ?? "—"} lots combined, max ${item.maxOpenPositions ?? "—"} open positions/orders.`],
    ["Execution", `Leverage 1:${item.leverage}. All fills, margins and rule checks run on the server — every order is validated before execution.`],
  ];
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <Button variant="ghost" onClick={onBack} className="mb-4 gap-2"><ArrowLeft className="h-4 w-4" />Back</Button>
      {item.demo && <DemoLine />}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div><p className="mb-1 text-sm text-primary">{item.name}</p><h1 className="text-3xl font-semibold sm:text-4xl">{money(item.size)} Challenge</h1></div>
        <div className="rounded-xl border border-border/60 bg-card/60 px-4 py-2.5"><p className="text-[11px] text-muted-foreground">Leverage</p><p className="text-xl font-semibold">1:{item.leverage}</p></div>
      </div>
      <div className="mb-6 flex flex-wrap gap-1.5">
        <StatChip label="Target" value={item.target != null ? `${item.target}%` : "—"} />
        <StatChip label="Daily DD" value={item.dailyDd != null ? `${item.dailyDd}%` : "—"} />
        <StatChip label="Max DD" value={item.maxDd != null ? `${item.maxDd}%` : "—"} />
        <StatChip label="Min days" value={String(item.minDays)} />
        <StatChip label="Max days" value={item.maxDays != null ? String(item.maxDays) : "—"} />
        <StatChip label="Max lot" value={item.maxLotsPerOrder != null ? String(item.maxLotsPerOrder) : "—"} />
        <StatChip label="Max positions" value={item.maxOpenPositions != null ? String(item.maxOpenPositions) : "—"} />
      </div>
      <section className="space-y-2">
        {rules.map(([title, text]) => (
          <details key={title} className="group rounded-xl border border-border/60 bg-card/60 px-4 py-3">
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium">{title}<ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" /></summary>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{text}</p>
          </details>
        ))}
      </section>
      {item.demo && <p className="mt-6 text-xs text-muted-foreground">All values are illustrative examples — confirm real terms with the provider before any purchase.</p>}
    </div>
  );
}

export default function PropFirmPage({ params }: { params?: { challengeId?: string } }) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"rankings" | "marketplace" | "custom" | "accounts">("marketplace");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // evaluated account ids — evaluate is idempotent but we run it once per mount
  const evaluatedRef = useRef<Set<string>>(new Set());

  const typesQ = useQuery({
    queryKey: ["pf-types"],
    queryFn: propApi.listChallengeTypes,
    enabled: !!user,
    retry: 1,
  });
  const accountsQ = useQuery({
    queryKey: ["pf-accounts"],
    queryFn: tradingApi.getAccounts,
    enabled: !!user,
    refetchInterval: 30_000,
  });

  const serverTypes: Phase6Type[] = (typesQ.data || []).map((ty) => ({
    id: ty.id, name: ty.name, size: ty.size, target: ty.profitTargetPct,
    dailyDd: ty.dailyLossLimitPct, maxDd: ty.maxDrawdownPct, minDays: ty.minTradingDays,
    maxDays: ty.maxTradingDays, maxLotsPerOrder: ty.maxLotsPerOrder, maxLotsTotal: ty.maxLotsTotal,
    maxOpenPositions: ty.maxOpenPositions, leverage: ty.leverage, description: ty.description,
  }));
  const types = serverTypes.length > 0 ? serverTypes : DEMO_TYPES;
  const isDemo = serverTypes.length === 0;

  const challenges = useMemo(
    () => (accountsQ.data || []).filter((a) => a.type === "CHALLENGE"),
    [accountsQ.data],
  );

  // auto-evaluate active challenge accounts once per mount — persists
  // PASSED/FAILED transitions even without trading activity
  const challengeIds = challenges.map((a) => a.id).join(",");
  useEffect(() => {
    if (!challengeIds) return;
    for (const id of challengeIds.split(",")) {
      if (evaluatedRef.current.has(id)) continue;
      evaluatedRef.current.add(id);
      tradingApi.evaluate(id).then(() => {
        queryClient.invalidateQueries({ queryKey: ["pf-accounts"] });
      }).catch(() => {});
    }
  }, [challengeIds, queryClient]);

  const selected = challenges.find((a) => a.id === selectedId) || challenges[0] || null;
  const detailsType = params?.challengeId ? types.find((x) => x.id === params!.challengeId) : undefined;

  if (params?.challengeId) {
    return detailsType
      ? <TypeDetails item={detailsType} onBack={() => navigate("/prop-firm")} />
      : <div className="mx-auto max-w-4xl p-8"><p>Challenge not found.</p><Button variant="ghost" onClick={() => navigate("/prop-firm")}><ArrowLeft className="mr-2 h-4 w-4" />Back to Prop Firm</Button></div>;
  }

  const tabs = [
    // P38 — Rankings hidden temporarily (owner request); restore the entry
    // below + the render block when it comes back
    { id: "marketplace" as const, label: t("pfTabMarket") },
    // Phase 35 — the custom-account builder (raw label: the page chrome is English)
    { id: "custom" as const, label: "Custom" },
    ...(user ? [{ id: "accounts" as const, label: t("pfTabMine") }] : []),
  ];

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="mb-1 flex items-center gap-2 text-xs font-semibold tracking-wider text-primary"><BarChart3 className="h-4 w-4" />PROP TRADING</p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Prop Firm Hub</h1>
            <p className="mt-1 text-sm text-muted-foreground">Pick a challenge format and start your funded journey.</p>
          </div>
        </div>
        {isDemo && <DemoLine />}

        <div className="mb-5 flex items-center gap-2" role="tablist" aria-label="Prop Firm sections">
          {tabs.map((item) => (
            <button
              key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}
              className={`rounded-full px-4 py-1.5 text-sm transition-colors ${tab === item.id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"}`}
            >{item.label}</button>
          ))}
        </div>

        {tab === "marketplace" && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {types.map((item) => <TypeCard key={item.id} item={item} onDetails={() => navigate(`/prop-firm/${item.id}`)} />)}
            {types.length === 0 && <div className="rounded-xl border border-border/60 p-8 text-center text-sm text-muted-foreground sm:col-span-2 lg:col-span-3">No challenges match.</div>}
          </div>
        )}

        {/* Phase 35 — Create Your Custom Account builder */}
        {tab === "custom" && (
          <CustomAccountBuilder onCreated={(accountId) => { setSelectedId(accountId); setTab("accounts"); }} />
        )}

        {tab === "accounts" && user && (
          challenges.length === 0 ? (
            <Card className="border-border/60 bg-card/50"><CardContent className="mx-auto max-w-md p-8 text-center sm:p-10">
              <Wallet className="mx-auto mb-3 h-9 w-9 text-primary" />
              <h2 className="text-lg font-semibold">{t("pfNoChallenges")}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("pfNoChallengesHint")}</p>
              <Button className="mt-5 bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setTab("marketplace")}>{t("pfTabMarket")}</Button>
            </CardContent></Card>
          ) : (
            <div className="space-y-4">
              {/* account switcher */}
              <div className="flex flex-wrap gap-2">
                {challenges.map((a) => (
                  <button
                    key={a.id} onClick={() => setSelectedId(a.id)}
                    className={cn(
                      "flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs transition-colors",
                      selected?.id === a.id ? "border-primary/50 bg-primary/10" : "border-border/60 bg-card/50 hover:border-primary/30",
                    )}
                  >
                    <span className="font-semibold">{a.challengeName || a.label}</span>
                    <span className="text-muted-foreground">{money(a.startingBalance)}</span>
                    <StatusBadge account={a} t={t} />
                  </button>
                ))}
              </div>
              {selected && (
                <div key={selected.id}>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <h2 className="text-lg font-semibold">{selected.challengeName || selected.label}</h2>
                      <StatusBadge account={selected} t={t} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {selected.startedAt ? `${t("pfDays")}: ${Math.max(1, Math.ceil((Date.now() - selected.startedAt) / 86_400_000))}${selected.rules?.maxTradingDays ? ` / ${selected.rules.maxTradingDays}` : ""}` : ""}
                    </p>
                  </div>
                  <ChallengeDashboard account={selected} t={t} />
                </div>
              )}
            </div>
          )
        )}
      </div>
    </main>
  );
}
