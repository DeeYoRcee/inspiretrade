import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CircleCheck as CheckCircle2, Clock3 } from "lucide-react";
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
    color: "text-sky-400",
    barColor: "bg-sky-400",
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

/**
 * Compact forex session tracker — one thin card with a row per session:
 * name · hours · slim progress bar · percent. Kept intentionally small so it
 * does not push the dashboard content below the fold.
 */
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
    <div className="mb-6 rounded-xl border border-primary/20 bg-gradient-to-r from-card via-card to-primary/5 px-3 py-2.5 sm:px-4">
      {/* Compact header: title · status · UTC clock */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5 text-primary">
          <Clock3 className="h-3.5 w-3.5" />
          <span className="text-[11px] font-semibold uppercase tracking-wider">
            {t("sessionTracker")}
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
          </span>
          {trackerStatus}
        </span>
        <span className="ml-auto rounded bg-secondary/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          UTC {utcTime}
        </span>
      </div>

      {/* One slim row per session */}
      <div className="mt-2 space-y-1.5">
        {sessions.map((session) => (
          <div key={session.key} className="flex items-center gap-2 sm:gap-3">
            <span
              className={cn(
                "w-16 shrink-0 truncate text-[11px] font-semibold sm:w-20 sm:text-xs",
                session.color,
                session.isActive && "drop-shadow-[0_0_6px_currentColor]",
              )}
            >
              {session.isActive ? sessionLabel(session.key) : session.isComplete ? (
                <span className="inline-flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3 text-success" />
                  {sessionLabel(session.key)}
                </span>
              ) : (
                sessionLabel(session.key)
              )}
            </span>
            <span className="hidden w-24 shrink-0 font-mono text-[10px] text-muted-foreground sm:block">
              {formatClock(session.startMinutes)}–{formatClock(session.endMinutes)}
            </span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
              <span
                className={cn("block h-full rounded-full transition-[width] duration-700", session.barColor)}
                style={{ width: `${session.progress}%` }}
              />
            </span>
            <span className="w-9 shrink-0 text-right font-mono text-[11px] font-semibold">
              {Math.round(session.progress)}%
            </span>
          </div>
        ))}
      </div>

      {/* Next session countdown */}
      <div className="mt-1.5 flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
        {allSessionsComplete ? (
          <span className="font-mono text-success">{t("sessionComplete")}</span>
        ) : (
          <>
            <span>{t("nextSession")}</span>
            <span className="text-primary">{sessionLabel(nextSession.key)}</span>
            <ArrowRight className="h-3 w-3" />
            <span className="font-mono">
              {t("sessionStartsIn")} {formatCountdown(Math.max(0, Math.floor(secondsUntilNext)))}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
