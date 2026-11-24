/**
 * AlertsPanel — Phase 5 "Alerts" tab: configure trading alerts.
 *
 * Reuses the app-wide alert settings store (client/src/lib/notifications.ts),
 * so this panel and the AlertsEngine stay in sync — the same settings drive
 * toasts, browser notifications and (when subscribed) web push.
 */
import { useEffect, useState } from "react";
import { BellRing, Monitor, MoonStar, RefreshCw, Smartphone, Trash2, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loadAlertSettings, saveAlertSettings, requestBrowserPermission, enableWebPush, isPushSubscribed, getAlertLog, clearAlertLog, loadEventAlerts, removeEventAlert, type AlertSettings, type EventAlert } from "@/lib/notifications";
import { TradingAlertsManager } from "./TradingAlertsManager";
import { readTerminalSnapshot } from "@/lib/terminal-bridge";
import { getTerminalSettings } from "@/lib/terminal-settings";
import type { Timeframe } from "@shared/terminal";
import { SYMBOLS, CALENDAR_CURRENCIES, SYMBOL_COLOR } from "@/lib/news-api";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { timeFmt } from "./alerts-format";

function Chip({ active, color, label, onClick }: { active: boolean; color?: string; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded border px-2 py-1 text-[11px] font-semibold transition-colors",
        active ? "border-primary/70 bg-primary/20 text-primary" : "border-border/80 text-muted-foreground hover:text-foreground/90",
      )}
      style={active && color ? { borderColor: color, color } : undefined}
    >
      {label}
    </button>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; hint?: string }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex w-full items-center gap-3 rounded-lg border border-border bg-background/60 px-3 py-2.5 text-left transition-colors hover:border-border">
      <span className={cn("flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors", checked ? "bg-primary" : "bg-secondary/70")}>
        <span className={cn("h-4 w-4 rounded-full bg-white transition-transform", checked && "translate-x-4")} />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-foreground/90">{label}</span>
        {hint && <span className="block text-[10px] leading-snug text-muted-foreground">{hint}</span>}
      </span>
    </button>
  );
}

export default function AlertsPanel({ symbol: symbolProp, timeframe: tfProp }: { symbol?: string; timeframe?: Timeframe } = {}) {
  const [settings, setSettings] = useState<AlertSettings>(loadAlertSettings);
  const [customAlerts, setCustomAlerts] = useState<EventAlert[]>(loadEventAlerts);
  const [log, setLog] = useState(getAlertLog);
  const [pushState, setPushState] = useState<string>("");

  useEffect(() => {
    void isPushSubscribed().then((ok) => setPushState(ok ? "subscribed" : ""));
  }, []);

  const update = (patch: Partial<AlertSettings>) => {
    const next = { ...loadAlertSettings(), ...patch };
    saveAlertSettings(next); // notifies AlertsEngine + syncs web-push snapshot
    setSettings(next);
  };

  const enableBrowser = async () => {
    const perm = await requestBrowserPermission();
    toast({ title: perm === "granted" ? "Browser notifications enabled" : `Permission: ${perm}`, description: perm === "granted" ? "Alerts will pop OS-level notifications." : "Enable notifications in your browser settings." });
    if (perm === "granted") update({ browser: true });
  };

  const enablePush = async () => {
    const res = await enableWebPush();
    if (res.ok) {
      setPushState("subscribed");
      toast({ title: "Web push enabled", description: "News + calendar alerts arrive even with the site closed." });
    } else {
      toast({ title: "Web push unavailable", description: `Reason: ${res.reason}. In-tab toasts still work.`, variant: "destructive" });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-2.5">
          <Toggle
            checked={settings.enabled}
            onChange={(v) => update({ enabled: v })}
            label="Master alerts switch"
            hint="Everything below fires toasts (and OS notifications when enabled) only while the site is open."
          />
          <Toggle
            checked={settings.calEnabled}
            onChange={(v) => update({ calEnabled: v })}
            label="High-impact economic event alerts"
            hint="Fires before High-impact releases in the currencies you pick."
          />
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs font-semibold text-foreground/90">Warn minutes before event</div>
            <div className="mt-2 flex gap-1.5">
              {[5, 15, 30, 60].map((m) => (
                <button
                  key={m}
                  onClick={() => update({ calMinutesBefore: m })}
                  className={cn(
                    "flex-1 rounded border px-2 py-1 text-[11px] font-bold tabular-nums transition-colors",
                    settings.calMinutesBefore === m ? "border-primary/70 bg-primary/20 text-primary" : "border-border/80 text-muted-foreground hover:text-foreground/90",
                  )}
                >
                  {m}m
                </button>
              ))}
            </div>
            <div className="mt-3 text-xs font-semibold text-foreground/90">Currencies</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {CALENDAR_CURRENCIES.map((c) => (
                <Chip
                  key={c} label={c}
                  active={settings.calCurrencies.includes(c)}
                  onClick={() => update({ calCurrencies: settings.calCurrencies.includes(c) ? settings.calCurrencies.filter((x) => x !== c) : [...settings.calCurrencies, c] })}
                />
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs font-semibold text-foreground/90">News alerts by instrument</div>
            <div className="mt-1 text-[10px] text-muted-foreground">Fresh headlines (&lt;45 min old) tagged with these instruments — XAUUSD is the gold watch.</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SYMBOLS.map((s) => (
                <Chip
                  key={s} label={s} color={SYMBOL_COLOR[s]}
                  active={settings.symbols.includes(s)}
                  onClick={() => update({ symbols: settings.symbols.includes(s) ? settings.symbols.filter((x) => x !== s) : [...settings.symbols, s] })}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-2.5">
          {/* PHASE 47 — the dedicated Trading Alerts manager (create / pause /
              resume / edit / duplicate / delete / search / trigger history) */}
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-semibold text-foreground/90">Trading alerts</div>
              <span className="text-[10px] text-muted-foreground">price · indicator · drawing</span>
            </div>
            {(() => {
              const snap = readTerminalSnapshot();
              const sym = symbolProp ?? snap?.symbol ?? getTerminalSettings().general.defaultSymbol;
              const tf = tfProp ?? snap?.timeframe ?? (getTerminalSettings().general.defaultTf as Timeframe);
              return <TradingAlertsManager symbol={sym} timeframe={tf} lastPrice={null} drawings={snap?.drawings ?? []} />;
            })()}
          </div>

          {/* PHASE 47 — unified notification preferences */}
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs font-semibold text-foreground/90">Notification categories</div>
            <div className="mt-2 space-y-1.5">
              <Toggle checked={settings.tradingAlerts ?? true} onChange={(v) => update({ tradingAlerts: v })} label="Trading alerts" hint="Price / indicator / drawing alert fires." />
              <Toggle checked={settings.systemNotifs ?? true} onChange={(v) => update({ systemNotifs: v })} label="Platform notifications" hint="System events (paused alerts, push status, …)." />
              <Toggle checked={settings.sound ?? false} onChange={(v) => update({ sound: v })} label={<span className="inline-flex items-center gap-1">Sound <Volume2 className="h-3 w-3" /></span>} hint="Short beep when an alert fires." />
            </div>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
              <MoonStar className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0">Quiet hours</span>
              <select className="h-7 flex-1 rounded border border-border bg-background px-1 text-[11px] text-foreground/90"
                value={settings.quietFrom ?? ""} onChange={(e) => update({ quietFrom: e.target.value === "" ? null : Number(e.target.value) })}>
                <option value="">off</option>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
              </select>
              <span>→</span>
              <select className="h-7 flex-1 rounded border border-border bg-background px-1 text-[11px] text-foreground/90"
                value={settings.quietTo ?? ""} onChange={(e) => update({ quietTo: e.target.value === "" ? null : Number(e.target.value) })}>
                <option value="">—</option>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
              </select>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs font-semibold text-foreground/90">Delivery</div>
            <div className="mt-2 space-y-2">
              <Button variant="outline" size="sm" className="w-full justify-start" onClick={enableBrowser}>
                <Monitor className="mr-2 h-3.5 w-3.5" /> Browser notifications {settings.browser ? "· on" : ""}
              </Button>
              <Button variant="outline" size="sm" className="w-full justify-start" onClick={enablePush} disabled={pushState === "subscribed"}>
                <Smartphone className="mr-2 h-3.5 w-3.5" /> {pushState === "subscribed" ? "Web push subscribed" : "Enable web push (works site-closed)"}
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-foreground/90">Custom event alerts ({customAlerts.length})</div>
              <span className="text-[10px] text-muted-foreground">Set from any calendar row</span>
            </div>
            <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
              {customAlerts.length === 0 && <div className="text-[11px] text-muted-foreground">No custom alerts yet.</div>}
              {customAlerts.map((a) => (
                <div key={a.id} className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px]">
                  <BellRing className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                  <span className="min-w-0 flex-1 truncate text-amber-200">{a.currency} · {a.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{a.minutesBefore}m before</span>
                  <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={() => { removeEventAlert(a.id); setCustomAlerts(loadEventAlerts()); }}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-foreground/90">Recent alert log</div>
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" className="h-6 w-6" title="Refresh log" onClick={() => { setLog(getAlertLog()); setCustomAlerts(loadEventAlerts()); }}>
                  <RefreshCw className="h-3 w-3" />
                </Button>
                <Button size="icon" variant="ghost" className="h-6 w-6" title="Clear log" onClick={() => { clearAlertLog(); setLog([]); }}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
            <div className="mt-2 max-h-44 space-y-1 overflow-y-auto">
              {log.length === 0 && <div className="text-[11px] text-muted-foreground">Nothing fired yet.</div>}
              {log.slice(0, 12).map((e) => (
                <div key={`${e.id}-${e.at}`} className="rounded-md border border-border px-2 py-1 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className={cn("rounded px-1 text-[9px] font-bold uppercase", e.kind === "news" ? "bg-primary/15 text-primary" : "bg-amber-900/60 text-amber-300")}>
                      {e.kind === "news" ? e.symbol || "news" : "calendar"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground/80">{e.title}</span>
                    <span className="shrink-0 text-[9px] text-muted-foreground">{timeFmt.format(e.at)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
