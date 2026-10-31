import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CheckCircle2, Clock3 } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";

type SessionKey = "asia" | "london" | "newYork";

type SessionDefinition = {
  key: SessionKey;
  startMinutes: number;
  endMinutes: number;
  color: string;
  barColor: string;
};

const SESSION_DEFINITIONS: SessionDefinition[] = [
  {
    key: "asia",
    startMinutes: 0,
    endMinutes: 9 * 60,
    color: "text-cyan-400",
    barColor: "bg-cyan-400",
  },
  {
    key: "london",
    startMinutes: 8 * 60,
    endMinutes: 17 * 60,
    color: "text-violet-400",
    barColor: "bg-violet-400",
  },
  {
    key: "newYork",
    startMinutes: 13 * 60,
    endMinutes: 22 * 60,
    color: "text-amber-400",
    barColor: "bg-amber-400",
  },
];

const SESSION_LABEL_KEYS: Record<SessionKey, "asiaSession" | "londonSession" | "newYorkSession"> = {
  asia: "asiaSession",
  london: "londonSession",
  newYork: "newYorkSession",
};

function getUtcMinutes(date: Date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
}

function formatClock(minutes: number) {
  const normalized = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hours = Math.floor(normalized / 60);
  const mins = Math.floor(normalized % 60);
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function formatCountdown(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function SessionTracker() {
  const { t } = useLanguage();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const currentMinutes = getUtcMinutes(now);
  const currentSeconds = Math.floor(currentMinutes * 60);

  const sessions = useMemo(
    () =>
      SESSION_DEFINITIONS.map((session) => {
        const duration = (session.endMinutes - session.startMinutes) * 60;
        const elapsed = currentSeconds - session.startMinutes * 60;
        const progress = Math.max(0, Math.min(100, (elapsed / duration) * 100));
        const isActive =
          currentMinutes >= session.startMinutes && currentMinutes < session.endMinutes;

        return {
          ...session,
          progress,
          isActive,
          isComplete: currentMinutes >= session.endMinutes,
        };
      }),
    [currentMinutes, currentSeconds],
  );

  const activeSessions = sessions.filter((session) => session.isActive);
  const primaryActiveSession = [...activeSessions].sort(
    (a, b) => b.startMinutes - a.startMinutes,
  )[0];
  const nextSession = SESSION_DEFINITIONS.find(
    (session) => session.startMinutes > currentMinutes,
  ) ?? SESSION_DEFINITIONS[0];
  const secondsUntilNext =
    (nextSession.startMinutes - currentMinutes + (nextSession.startMinutes <= currentMinutes ? 1440 : 0)) * 60;
  const allSessionsComplete = sessions.every((session) => session.isComplete);
  const utcTime = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}:${String(now.getUTCSeconds()).padStart(2, "0")}`;

  const sessionLabel = (key: SessionKey) => t(SESSION_LABEL_KEYS[key]);
  const trackerStatus = primaryActiveSession
    ? `${sessionLabel(primaryActiveSession.key)} ${t("sessionActive")}`
    : allSessionsComplete
      ? t("allSessionsComplete")
      : t("sessionWaiting");

  return (
    <Card className="mb-8 overflow-hidden border-primary/20 bg-gradient-to-br from-card via-card to-primary/5 shadow-lg">
      <CardHeader className="border-b border-border/40 px-5 py-4 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Clock3 className="h-5 w-5" />
              <span className="text-sm font-semibold uppercase tracking-wider">
                {t("sessionTracker")}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t("sessionUtc")}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 text-sm font-medium text-foreground">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/70" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
              </span>
              {trackerStatus}
            </span>
            <span className="rounded-md bg-secondary/70 px-2 py-1 font-mono text-xs text-muted-foreground">
              UTC {utcTime}
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-5 py-5 sm:px-6">
        <div className="grid gap-3 md:grid-cols-3">
          {sessions.map((session) => (
            <div
              key={session.key}
              className={cn(
                "rounded-xl border bg-background/35 p-4 transition-all",
                session.isActive
                  ? "border-primary/50 shadow-[0_0_24px_rgba(99,102,241,0.12)]"
                  : "border-border/50",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className={cn("text-base font-semibold", session.color)}>
                    {sessionLabel(session.key)}
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {formatClock(session.startMinutes)}–{formatClock(session.endMinutes)} UTC
                  </p>
                </div>
                {session.isComplete ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                ) : (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      session.isActive
                        ? "bg-primary/15 text-primary"
                        : "bg-secondary text-muted-foreground",
                    )}
                  >
                    {session.isActive ? t("sessionActive") : t("sessionWaiting")}
                  </span>
                )}
              </div>

              <div className="mt-4 flex items-end justify-between gap-3">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    className={cn("h-full rounded-full transition-[width] duration-700", session.barColor)}
                    style={{ width: `${session.progress}%` }}
                  />
                </div>
                <span className="min-w-12 text-right font-mono text-sm font-semibold">
                  {Math.round(session.progress)}%
                </span>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">{t("sessionProgress")}</p>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/40 bg-secondary/30 px-3 py-2.5 text-sm">
          <span className="text-muted-foreground">
            {allSessionsComplete ? t("allSessionsComplete") : t("nextSession")}
          </span>
          <span className="flex items-center gap-2 font-medium">
            {!allSessionsComplete && (
              <>
                <span className="text-primary">{sessionLabel(nextSession.key)}</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                <span className="font-mono text-xs text-muted-foreground">
                  {t("sessionStartsIn")} {formatCountdown(Math.max(0, Math.floor(secondsUntilNext)))}
                </span>
              </>
            )}
            {allSessionsComplete && (
              <span className="font-mono text-xs text-success">
                {t("sessionComplete")}
              </span>
            )}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}