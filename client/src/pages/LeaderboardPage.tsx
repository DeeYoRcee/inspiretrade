import { LeaderboardPageHeader, LeaderboardPanel } from "@/components/leaderboard/LeaderboardPanel";

/** Standalone leaderboard page — the panel itself now lives inside the
 *  Prop Firm hub (first tab); this route remains for existing links. */
export default function LeaderboardPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <LeaderboardPageHeader />
        <LeaderboardPanel />
      </div>
    </main>
  );
}
