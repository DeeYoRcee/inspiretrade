/**
 * AlertsPanel — Phase 5 "Alerts" tab, SIMPLIFIED (P64R user request: the old
 * panel mixed trading alerts with economic-calendar chips, currency grids,
 * quiet hours, an event-alert list and an activity log and became impossible
 * to read — now it is just the master switch, the trading alerts manager and
 * delivery options).
 *
 * Reuses the app-wide alert settings store (client/src/lib/notifications.ts),
 * so this panel and the AlertsEngine stay in sync — the same settings drive
 * toasts, browser notifications and (when subscribed) web push.
 * Economic-calendar warn minutes/currencies still live in the calendar's own
 * bell dialog, where they are set.
 */
import { useEffect, useState } from "react";
import { Monitor, Smartphone, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loadAlertSettings, saveAlertSettings, requestBrowserPermission, enableWebPush, isPushSubscribed, type AlertSettings } from "@/lib/notifications";
import { TradingAlertsManager } from "./TradingAlertsManager";
import { readTerminalSnapshot } from "@/lib/terminal-bridge";
import { getTerminalSettings } from "@/lib/terminal-settings";
import type { Timeframe } from "@shared/terminal";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";

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
      toast({ title: "Web push enabled", description: "Trading alerts arrive even with the site closed." });
    } else {
      toast({ title: "Web push unavailable", description: `Reason: ${res.reason}. In-tab toasts still work.`, variant: "destructive" });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
      {/* 1 — one master switch */}
      <Toggle
        checked={settings.enabled}
        onChange={(v) => update({ enabled: v })}
        label="Alerts on/off"
        hint="All alerts fire toasts (and OS notifications when enabled) only while this switch is on."
      />

      {/* 2 — the core: price / indicator / drawing alerts */}
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

      {/* 3 — how alerts reach you */}
      <div className="rounded-lg border border-border bg-background/60 p-3">
        <div className="text-xs font-semibold text-foreground/90">Delivery</div>
        <div className="mt-2 space-y-2">
          <Toggle checked={settings.sound ?? false} onChange={(v) => update({ sound: v })} label={<span className="inline-flex items-center gap-1">Sound <Volume2 className="h-3 w-3" /></span>} hint="Short beep when an alert fires." />
          <Button variant="outline" size="sm" className="w-full justify-start" onClick={enableBrowser}>
            <Monitor className="mr-2 h-3.5 w-3.5" /> Browser notifications {settings.browser ? "· on" : ""}
          </Button>
          <Button variant="outline" size="sm" className="w-full justify-start" onClick={enablePush} disabled={pushState === "subscribed"}>
            <Smartphone className="mr-2 h-3.5 w-3.5" /> {pushState === "subscribed" ? "Web push subscribed" : "Enable web push (works site-closed)"}
          </Button>
        </div>
      </div>
    </div>
  );
}
