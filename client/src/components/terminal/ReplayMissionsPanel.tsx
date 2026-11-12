/**
 * ReplayMissionsPanel (§11) — practice missions with progress tracking.
 * Completed missions are written once to RTDB
 * `terminalReplayAchievements/{uid}/{missionId}` and shown with a badge.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Award, Trophy } from "lucide-react";
import { ref, get, set } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "@/hooks/use-auth";
import { MISSIONS, missionContext } from "@/lib/terminal/replay-missions";
import type { ReplaySession } from "@/hooks/use-replay";
import { cn } from "@/lib/utils";

export function ReplayMissionsPanel({ rs }: { rs: ReplaySession }) {
  const { user } = useAuth();
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["replayAchievements", user?.uid],
    enabled: !!user,
    queryFn: async (): Promise<Record<string, { completedAt: number }>> => {
      const snap = await get(ref(db, `terminalReplayAchievements/${user!.uid}`));
      return snap.exists() ? snap.val() : {};
    },
  });
  const achieved = q.data ?? {};

  // auto-award newly completed missions
  useEffect(() => {
    if (!user) return;
    const ctx = missionContext(rs.engine.closed, rs.cfg, 0, rs.challenge?.status === "passed");
    for (const m of MISSIONS) {
      if (achieved[m.id]) continue;
      if (m.done(rs.engine.closed, ctx)) {
        set(ref(db, `terminalReplayAchievements/${user.uid}/${m.id}`), { completedAt: Date.now() })
          .then(() => qc.invalidateQueries({ queryKey: ["replayAchievements", user.uid] }))
          .catch(() => { /* write failed — retried next render cycle */ });
      }
    }
  }, [rs.engine.closed, rs.cfg, rs.challenge, achieved, user, qc]);

  const ctx = missionContext(rs.engine.closed, rs.cfg, 0, rs.challenge?.status === "passed");

  return (
    <div className="space-y-2 p-3 text-[11px]">
      <div className="flex items-center justify-between">
        <b className="flex items-center gap-1.5"><Trophy className="h-4 w-4 text-amber-400" />Practice missions</b>
        <span className="text-muted-foreground">{Object.keys(achieved).length}/{MISSIONS.length} earned</span>
      </div>
      {MISSIONS.map((m) => {
        const done = !!achieved[m.id];
        const p = Math.round(m.progress(rs.engine.closed, ctx) * 100);
        return (
          <div key={m.id} className={cn("rounded-xl border p-2.5", done ? "border-amber-500/40 bg-amber-500/5" : "border-border/50 bg-card/40")}>
            <div className="flex items-center gap-2">
              <Award className={cn("h-4 w-4", done ? "text-amber-400" : "text-muted-foreground")} />
              <b className={done ? "text-amber-300" : ""}>{m.name}</b>
              {done && <span className="ml-auto rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-black text-amber-400">EARNED</span>}
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{m.description}</p>
            {!done && (
              <div className="mt-1.5 flex items-center gap-2">
                <div className="h-1.5 flex-1 rounded-full bg-muted/50">
                  <div className="h-full rounded-full bg-sky-500/60" style={{ width: `${Math.min(100, p)}%` }} />
                </div>
                <span className="font-number text-[10px] text-muted-foreground">{p}%</span>
              </div>
            )}
            {done && <p className="mt-0.5 text-[9px] text-muted-foreground">Earned {new Date(achieved[m.id].completedAt).toLocaleDateString()}</p>}
          </div>
        );
      })}
      {!user && <p className="text-[9px] text-amber-400">Sign in to save achievements.</p>}
    </div>
  );
}
