/**
 * Phase 35 — "Create Your Custom Account" builder on the Prop Firm Hub,
 * modeled on the reference flow the owner shared (Vest Markets): account-size
 * slider, 2-Step / 1-Step / Instant format, optional rule sliders and a live
 * "Your Build" summary with a one-time payment line.
 *
 * Buy Now creates a REAL server-enforced CHALLENGE account via
 * /api/trading?action=create — the same endpoint the terminal's
 * NewAccountDialog uses (rules validated by store.sanitizeRules).
 *
 * PLACEHOLDER PRICING: BASE_PRICE and the modifier factors below are temporary
 * numbers chosen for the demo (owner request 2026-11-21 — real prices will be
 * provided later). Nothing is charged today: there is no payment rail for
 * challenges yet, so Buy Now creates the account directly.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useTrading } from "@/hooks/use-trading";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { PropRules } from "@shared/trading-engine";
import { cn } from "@/lib/utils";
import { CHALLENGES_ENABLED } from "@shared/roles";

/** Server clamps startingBalance to 5,000…5,000,000 (store.createAccount). */
const SIZE_STOPS = [5000, 10000, 25000, 50000, 100000, 200000];

/** PLACEHOLDER — replace with the owner's real price list. */
const BASE_PRICE: Record<number, number> = {
  5000: 29, 10000: 49, 25000: 89, 50000: 149, 100000: 249, 200000: 449,
};

/** Server-allowed leverages (ALLOWED_LEVERAGES in trading/store.ts). */
const LEVERAGES = [10, 20, 30, 50, 100, 200, 500];

type Kind = "2step" | "1step" | "instant";

const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: "2step", label: "2-Step", hint: "Two evaluation phases" },
  { id: "1step", label: "1-Step", hint: "One evaluation phase" },
  { id: "instant", label: "Instant", hint: "No evaluation" },
];

const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const money2 = (v: number) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function tierFor(size: number): { label: string; cls: string } {
  if (size >= 100000) return { label: "ELITE", cls: "from-sky-300 to-indigo-400" };
  if (size >= 50000) return { label: "DIAMOND", cls: "from-cyan-200 to-sky-400" };
  if (size >= 25000) return { label: "PLATINUM", cls: "from-slate-200 to-slate-400" };
  if (size >= 10000) return { label: "GOLD", cls: "from-amber-300 to-yellow-500" };
  if (size >= 5000) return { label: "SILVER", cls: "from-zinc-300 to-zinc-400" };
  return { label: "BRONZE", cls: "from-orange-300 to-amber-500" };
}

/** PLACEHOLDER price model — base + rule modifiers, one decimal place. */
function buildPrice(size: number, kind: Kind, split: number, maxDd: number) {
  const base = BASE_PRICE[size] ?? 29;
  let factor = 1;
  const mods: string[] = [];
  if (split > 80) { factor += 0.02 * (split - 80); mods.push(`Profit ${split}%`); }
  if (maxDd < 6) { factor += 0.03 * (6 - maxDd); mods.push(`Tight DD ${maxDd}%`); }
  if (kind === "instant") { factor += 0.25; mods.push("Instant"); }
  if (kind === "1step") { factor -= 0.10; mods.push("1-Step −10%"); }
  return { base, final: Math.max(1, Math.round(base * factor * 100) / 100), mods };
}

function SummaryRow({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn("font-number tabular-nums", strong ? "text-base font-bold" : "text-sm font-semibold")}>{v}</dd>
    </div>
  );
}

function RuleSlider({ label, value, min, max, step, suffix, onChange }: {
  label: string; value: number; min: number; max: number; step: number; suffix: string; onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-number text-sm font-bold">{value}{suffix}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value} aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-emerald-400"
      />
      <div className="flex justify-between font-number text-[9px] text-muted-foreground">
        <span>{min}{suffix}</span><span>{max}{suffix}</span>
      </div>
    </div>
  );
}

export function CustomAccountBuilder({ onCreated }: { onCreated: (accountId: string) => void }) {
  const { user } = useAuth();
  const { createAccount, busy: creating } = useTrading();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [sizeIdx, setSizeIdx] = useState(1); // $10,000
  const [kind, setKind] = useState<Kind>("2step");
  const [target, setTarget] = useState(10);
  const [maxDd, setMaxDd] = useState(6);
  const [dailyLoss, setDailyLoss] = useState(3);
  const [split, setSplit] = useState(80);
  const [leverage, setLeverage] = useState(100);

  const size = SIZE_STOPS[sizeIdx];
  const tier = tierFor(size);
  const price = buildPrice(size, kind, split, maxDd);
  const kindLabel = KINDS.find((k) => k.id === kind)!.label;

  // Instant = no evaluation: the engine only "passes" at the unreachable
  // +100 % target, so the account behaves as a risk-limited funded account.
  const rules: PropRules = useMemo(() => ({
    dailyLossLimitPct: dailyLoss,
    maxDrawdownPct: maxDd,
    profitTargetPct: kind === "instant" ? 100 : target,
    minTradingDays: 0,
    maxLotsTotal: null,
    maxLotsPerOrder: null,
    maxOpenPositions: null,
    maxTradingDays: kind === "instant" ? 365 : null,
  }), [kind, target, maxDd, dailyLoss]);

  const submit = async () => {
    if (!user) {
      toast({ title: "Sign in required", description: "Sign in to create your custom challenge account." });
      return;
    }
    try {
      const acc = await createAccount({
        label: `Custom ${kindLabel} ${size / 1000}K`.slice(0, 32),
        startingBalance: size,
        leverage,
        rules,
      });
      if (!acc) {
        toast({ title: "Could not create the account", description: "Try again in a moment." });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["pf-accounts"] });
      toast({
        title: `Custom ${money(size)} ${kindLabel} account created`,
        description: kind === "instant"
          ? "Risk rules only — no profit target. Find it under My accounts."
          : `Target ${target}% · drawdown ${maxDd}% · daily loss ${dailyLoss}%. Find it under My accounts.`,
      });
      onCreated(acc.id);
    } catch (e) {
      toast({
        title: "Could not create the account",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
      {/* ---- controls ---- */}
      <Card className="border-border/60 bg-card/50">
        <CardContent className="space-y-6 p-5 sm:p-6">
          <div className="text-center">
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">Create Your Custom Account</h2>
            <p className="mt-1 text-sm text-muted-foreground">How much do you want to trade with?</p>
            <p className="mt-2 font-number text-5xl font-bold tracking-tight sm:text-6xl">{money(size)}</p>
          </div>

          <div>
            <input
              type="range" min={0} max={SIZE_STOPS.length - 1} step={1} value={sizeIdx} aria-label="Account size"
              onChange={(e) => setSizeIdx(Number(e.target.value))}
              className="w-full accent-emerald-400"
            />
            <div className="mt-1 flex justify-between gap-0.5 overflow-x-auto font-number text-[10px] text-muted-foreground">
              {SIZE_STOPS.map((s, i) => (
                <button key={s} onClick={() => setSizeIdx(i)} className={cn("tabular-nums hover:text-foreground", i === sizeIdx && "font-bold text-foreground")}>
                  {s >= 1000 ? `$${s / 1000}K` : `$${s}`}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">Choose Account Type</p>
            <div className="grid grid-cols-3 gap-2">
              {KINDS.map((k) => (
                <button
                  key={k.id} onClick={() => setKind(k.id)} aria-pressed={kind === k.id}
                  className={cn(
                    "rounded-xl border px-2 py-3 text-center transition-colors",
                    kind === k.id ? "border-primary/60 bg-primary/10" : "border-border/60 bg-card/40 hover:border-primary/30",
                  )}
                >
                  <span className="block text-sm font-semibold">{k.label}</span>
                  <span className="mt-0.5 block text-[10px] leading-tight text-muted-foreground">{k.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border/50 bg-card/40 p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {kind === "instant" ? "Instant Account Risk Rules" : "Optional Rules"}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {kind !== "instant" && (
                <RuleSlider label="Profit Target" value={target} min={5} max={20} step={1} suffix="%" onChange={setTarget} />
              )}
              <RuleSlider label="Max. Drawdown" value={maxDd} min={4} max={10} step={1} suffix="%" onChange={setMaxDd} />
              <RuleSlider label="Max. Daily Loss" value={dailyLoss} min={2} max={6} step={1} suffix="%" onChange={setDailyLoss} />
              <RuleSlider label="Profit Split" value={split} min={70} max={95} step={5} suffix="%" onChange={setSplit} />
            </div>
            <div className="mt-4">
              <p className="mb-1.5 text-[10px] font-medium text-muted-foreground">Leverage</p>
              <div className="flex flex-wrap gap-1">
                {LEVERAGES.map((l) => (
                  <button
                    key={l} onClick={() => setLeverage(l)} aria-pressed={leverage === l}
                    className={cn(
                      "rounded-md border px-2 py-1 font-number text-[11px] font-semibold",
                      leverage === l ? "border-primary/60 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground",
                    )}
                  >1:{l}</button>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---- Your Build ---- */}
      <Card className="h-fit border-border/60 bg-card/50 lg:sticky lg:top-6">
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">Your Build</h3>
            <span className={cn("rounded-full bg-gradient-to-r px-2.5 py-0.5 text-[10px] font-black tracking-wider text-black", tier.cls)}>
              {tier.label}
            </span>
          </div>

          <dl className="space-y-2">
            <SummaryRow k="Account Size" v={money(size)} strong />
            {kind !== "instant" && kind === "2step" && (
              <>
                <SummaryRow k="Step 1 Profit Target" v={`${money((size * target) / 100)} (${target} %)`} />
                <SummaryRow k="Step 2 Profit Target" v={`${money((size * target) / 200)} (${target / 2} %)`} />
              </>
            )}
            {kind === "1step" && (
              <SummaryRow k="Profit Target" v={`${money((size * target) / 100)} (${target} %)`} />
            )}
            {kind === "instant" && (
              <SummaryRow k="Evaluation" v="None (risk rules only)" />
            )}
            <SummaryRow k="Max. Drawdown" v={`${money((size * maxDd) / 100)} (${maxDd} %)`} />
            <SummaryRow k="Max. Daily Loss" v={`${money((size * dailyLoss) / 100)} (${dailyLoss} %)`} />
            <SummaryRow k="Profit Split" v={`${split} %`} />
            <SummaryRow k="Leverage" v={`1:${leverage}`} />
          </dl>

          {price.mods.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-medium text-muted-foreground">Cost modifiers</p>
              <div className="flex flex-wrap gap-1.5">
                {price.mods.map((m) => (
                  <span key={m} className="rounded-full border border-emerald-500/50 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-400">
                    {m}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-border/50 bg-card/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">One-Time Payment</span>
              <span className="text-right">
                {price.final !== price.base && (
                  <span className="mr-2 font-number text-xs text-muted-foreground line-through">{money2(price.base)}</span>
                )}
                <span className="font-number text-2xl font-bold">{money2(price.final)}</span>
              </span>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">Placeholder pricing — real prices coming soon.</p>
          </div>

          {!CHALLENGES_ENABLED && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-center text-[11px] font-medium text-amber-400">
              Challenge purchases are temporarily unavailable — they will open at launch.
            </p>
          )}

          <Button
            className="w-full rounded-xl bg-emerald-500 font-semibold text-black hover:bg-emerald-400"
            disabled={creating || !CHALLENGES_ENABLED}
            onClick={submit}
          >
            {creating ? "Creating…" : <><Rocket className="mr-2 h-4 w-4" />Buy Now</>}
          </Button>
          {!user && <p className="text-center text-[10px] text-muted-foreground">Sign in to create the account.</p>}

          <p className="text-center text-[10px] leading-4 text-muted-foreground">
            The account is created instantly with server-enforced rules. The engine enforces one
            evaluation phase today — the 2-Step format's Step 2 target activates with payouts.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
