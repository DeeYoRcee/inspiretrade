/**
 * NewAccountDialog — create a DEMO account (plain virtual balance) or a
 * CHALLENGE account with configurable prop-firm rules. The rules are
 * re-validated and clamped server-side; this form only collects them.
 */
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useTrading } from "@/hooks/use-trading";
import { DEFAULT_PROP_RULES, type PropRules } from "@shared/trading-engine";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { CHALLENGES_ENABLED } from "@shared/roles";
import { cn } from "@/lib/utils";

const LEVERAGES = [10, 20, 30, 50, 100, 200, 500];
const BALANCES = [5000, 10000, 25000, 50000, 100000, 200000];

export function NewAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const { createAccount, busy, accounts } = useTrading();
  const [kind, setKind] = useState<"demo" | "challenge">("demo");
  const [balance, setBalance] = useState(100000);
  const [leverage, setLeverage] = useState(100);
  const [rules, setRules] = useState<PropRules>({ ...DEFAULT_PROP_RULES });
  const num = (v: string) => (v === "" ? null : Number(v));

  const patchRule = (patch: Partial<PropRules>) => setRules((r) => ({ ...r, ...patch }));

  const submit = async () => {
    if (kind === "challenge" && !CHALLENGES_ENABLED) return; // P38 kill-switch
    const acc = await createAccount({
      label: kind === "challenge" ? `Challenge ${accounts.length}` : `DEMO ${accounts.length + 1}`,
      startingBalance: balance,
      leverage,
      rules: kind === "challenge" ? rules : null,
    });
    if (acc) {
      toast({
        title: `${kind === "challenge" ? "Challenge" : "DEMO"} account created`,
        description: `$${balance.toLocaleString()} · 1:${leverage}${kind === "challenge" ? " · rules active" : ""}`,
      });
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New trading account</DialogTitle>
          <DialogDescription>
            A DEMO account trades freely. A CHALLENGE account enforces prop-firm rules
            server-side and reports Active / Passed / Failed status.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1.5">
          {((["demo", "challenge"] as const).filter((k) => k === "demo" || CHALLENGES_ENABLED)).map((k) => (
            <button
              key={k} onClick={() => setKind(k)}
              className={cn(
                "flex-1 rounded-lg border px-3 py-1.5 text-xs font-semibold capitalize",
                kind === k ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-400" : "border-border/60 text-muted-foreground",
              )}
            >{k === "demo" ? "DEMO (free trading)" : "PROP CHALLENGE"}</button>
          ))}
        </div>

        <div className="space-y-2.5 text-xs">
          <div>
            <span className="mb-1 block text-[10px] font-medium text-muted-foreground">Starting balance</span>
            <div className="flex flex-wrap gap-1">
              {BALANCES.map((b) => (
                <button key={b} onClick={() => setBalance(b)}
                  className={cn("rounded-md border px-2 py-1 font-number text-[11px]", balance === b ? "border-emerald-500/60 text-emerald-400" : "border-border/60 text-muted-foreground hover:text-foreground")}>
                  ${b.toLocaleString()}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="mb-1 block text-[10px] font-medium text-muted-foreground">Leverage (margin = notional / leverage)</span>
            <div className="flex flex-wrap gap-1">
              {LEVERAGES.map((l) => (
                <button key={l} onClick={() => setLeverage(l)}
                  className={cn("rounded-md border px-2 py-1 text-[11px] font-semibold", leverage === l ? "border-emerald-500/60 text-emerald-400" : "border-border/60 text-muted-foreground hover:text-foreground")}>
                  1:{l}
                </button>
              ))}
            </div>
          </div>

          {kind === "challenge" && (
            <div className="space-y-2 rounded-lg border border-border/50 bg-card/40 p-2.5">
              <p className="text-[11px] font-semibold text-amber-300">Prop-firm rules (server-enforced)</p>
              <div className="grid grid-cols-2 gap-2">
                <RuleInput label="Daily loss limit %" value={rules.dailyLossLimitPct} onChange={(v) => patchRule({ dailyLossLimitPct: v })} placeholder="5" />
                <RuleInput label="Max drawdown %" value={rules.maxDrawdownPct} onChange={(v) => patchRule({ maxDrawdownPct: v })} placeholder="10" />
                <RuleInput label="Profit target %" value={rules.profitTargetPct} onChange={(v) => patchRule({ profitTargetPct: v })} placeholder="10" />
                <RuleInput label="Min trading days" value={rules.minTradingDays} onChange={(v) => patchRule({ minTradingDays: v == null ? 0 : Math.floor(v) })} placeholder="3" />
                <RuleInput label="Max lots per order" value={rules.maxLotsPerOrder} onChange={(v) => patchRule({ maxLotsPerOrder: v })} placeholder="5" />
                <RuleInput label="Max combined lots" value={rules.maxLotsTotal} onChange={(v) => patchRule({ maxLotsTotal: v })} placeholder="10" />
                <RuleInput label="Max open positions" value={rules.maxOpenPositions} onChange={(v) => patchRule({ maxOpenPositions: v == null ? null : Math.floor(v) })} placeholder="10" />
              </div>
              <p className="text-[10px] text-muted-foreground">
                Breaching the daily loss or drawdown limit fails the challenge instantly and closes every position.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <button onClick={onClose} className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground">Cancel</button>
          <button onClick={submit} disabled={busy} className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-black disabled:opacity-40">
            {busy ? "Creating…" : "Create account"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RuleInput({ label, value, onChange, placeholder }: { label: string; value: number | null; onChange: (v: number | null) => void; placeholder?: string }) {
  return (
    <label>
      <span className="mb-0.5 block text-[10px] text-muted-foreground">{label}</span>
      <input
        type="number" step="any" className="num-input" placeholder={placeholder}
        defaultValue={value ?? ""}
        onBlur={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        key={String(value ?? "empty")}
      />
    </label>
  );
}
