import { useMemo } from "react";
import { Award, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useUserProfile } from "@/hooks/use-premium";
import { useTrades } from "@/hooks/use-trades";
import { useLanguage } from "@/lib/language-context";
import { useEconomy } from "@/hooks/use-economy";

/**
 * Prop-firm style achievement certificate (A4 landscape) rendered from the
 * user's real journal stats. "Download PDF" opens the browser print dialog —
 * "Save as PDF" produces the file (no server roundtrip, pixel-exact output).
 */
export default function CertificatePage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { data: profile } = useUserProfile();
  const { data: trades } = useTrades();
  const { data: economy } = useEconomy();

  const stats = useMemo(() => {
    const list = trades || [];
    const wins = list.filter((x) => x.profit > 0).length;
    const netPnl = list.reduce((s, x) => s + x.profit, 0);
    const winRate = list.length ? Math.round((wins / list.length) * 100) : 0;
    const bestDayMap: Record<string, number> = {};
    for (const trade of list) {
      const day = new Date(trade.timestamp).toISOString().slice(0, 10);
      bestDayMap[day] = (bestDayMap[day] || 0) + trade.profit;
    }
    const bestDay = Object.entries(bestDayMap).sort((a, b) => b[1] - a[1])[0];
    return {
      total: list.length,
      wins,
      netPnl,
      winRate,
      bestDayProfit: bestDay ? bestDay[1] : 0,
      bestDayDate: bestDay ? bestDay[0] : null,
    };
  }, [trades]);

  const name =
    profile?.username
      ? `@${profile.username}`
      : user?.displayName || user?.email?.split("@")[0] || "Trader";

  const certId = useMemo(() => {
    if (!user) return "INSP-XXXXXXXX";
    const base = `${user.uid}${Date.now()}`;
    let hash = 0;
    for (const c of base) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    return `INSP-${hash.toString(36).toUpperCase().slice(0, 8)}`;
  }, [user]);

  const issued = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });

  return (
    <div className="container mx-auto max-w-5xl space-y-4 p-4 sm:px-6">
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .certificate-print-area, .certificate-print-area * { visibility: visible !important; }
          .certificate-print-area {
            position: fixed !important; inset: 0 !important; margin: 0 !important;
            width: 100vw !important; max-width: none !important; padding: 0 !important;
          }
          .certificate-no-print { display: none !important; }
          @page { size: A4 landscape; margin: 0; }
        }
      `}</style>

      <div className="certificate-no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
            <Award className="h-6 w-6 text-amber-400" />
            {t("certificate")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("certificateSubtitle")}</p>
        </div>
        <Button size="lg" onClick={() => window.print()} className="rounded-xl font-semibold">
          <Printer className="mr-2 h-5 w-5" />
          {t("certificateDownload")}
        </Button>
      </div>

      {/* A4 landscape certificate */}
      <div className="certificate-print-area flex justify-center">
        <div
          className="relative flex aspect-[297/210] w-full max-w-[1000px] flex-col justify-between overflow-hidden rounded-sm p-1"
          style={{
            background: "linear-gradient(135deg, #0a0a0a 0%, #141414 55%, #1a1408 100%)",
          }}
        >
          {/* gold frame */}
          <div className="absolute inset-0 rounded-sm" style={{ padding: "6px", background: "linear-gradient(120deg, #d4af37, #f5e08a 30%, #a8842a 60%, #f5e08a 85%, #d4af37)" }}>
            <div className="flex h-full w-full flex-col justify-between p-[26px]" style={{ background: "linear-gradient(135deg, #0a0a0a 0%, #141414 55%, #1a1408 100%)" }}>
              {/* header */}
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <img src="/logo.png" alt="InspireTrade" className="h-11 w-auto object-contain" />
                </div>
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-[0.3em] text-[#f5e08a]">Certificate ID</p>
                  <p className="font-mono text-sm font-bold text-[#f5e08a]">{certId}</p>
                </div>
              </div>

              {/* title */}
              <div className="text-center">
                <p className="text-[11px] uppercase tracking-[0.45em] text-[#f5e08a]/80">InspireTrade Trading Journal</p>
                <h1
                  className="mt-1 text-4xl font-black uppercase tracking-[0.18em] text-transparent sm:text-5xl"
                  style={{
                    background: "linear-gradient(120deg, #d4af37, #f9ec9f 40%, #d4af37 70%, #f5e08a)",
                    WebkitBackgroundClip: "text",
                    backgroundClip: "text",
                  }}
                >
                  Certificate of Achievement
                </h1>
                <p className="mt-2 text-xs uppercase tracking-[0.25em] text-white/60">Trading Performance Verification</p>
              </div>

              {/* presented to */}
              <div className="text-center">
                <p className="text-[11px] uppercase tracking-[0.3em] text-white/50">{t("certificatePresentedTo")}</p>
                <p className="mt-1 text-2xl font-bold text-white sm:text-3xl">{name}</p>
                <div className="mx-auto mt-2 h-px w-56" style={{ background: "linear-gradient(90deg, transparent, #d4af37, transparent)" }} />
              </div>

              {/* stats */}
              <div className="mx-auto grid w-full max-w-3xl grid-cols-4 gap-3 text-center">
                {[
                  { label: t("certNetPnl"), value: `${stats.netPnl >= 0 ? "+" : "-"}$${Math.abs(stats.netPnl).toFixed(2)}` },
                  { label: t("certWinRate"), value: `${stats.winRate}%` },
                  { label: t("certTotalTrades"), value: String(stats.total) },
                  { label: t("certBestDay"), value: stats.bestDayProfit ? `+$${stats.bestDayProfit.toFixed(0)}` : "—" },
                ].map((item) => (
                  <div key={item.label} className="rounded-md border border-[#d4af37]/30 bg-[#d4af37]/5 px-2 py-3">
                    <p className="font-mono text-lg font-bold text-[#f5e08a] sm:text-xl">{item.value}</p>
                    <p className="mt-0.5 text-[9px] uppercase tracking-widest text-white/50">{item.label}</p>
                  </div>
                ))}
              </div>

              {/* footer: date + signature */}
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.25em] text-white/50">{t("certificateIssued")}</p>
                  <p className="text-sm font-semibold text-white">{issued}</p>
                </div>
                <div className="flex items-end gap-10">
                  <div className="text-center">
                    <p
                      className="text-xl italic text-[#f5e08a]"
                      style={{ fontFamily: "'Brush Script MT', 'Segoe Script', cursive" }}
                    >
                      DeeYoRcee_Inspire
                    </p>
                    <div className="mx-auto h-px w-40" style={{ background: "linear-gradient(90deg, transparent, #d4af37, transparent)" }} />
                    <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-white/80">DeeYoRcee_Inspire</p>
                    <p className="text-[9px] uppercase tracking-[0.25em] text-white/50">CEO &amp; Founder · InspireTrade</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="certificate-no-print text-center text-xs text-muted-foreground">{t("certificateNote")}</p>
    </div>
  );
}
