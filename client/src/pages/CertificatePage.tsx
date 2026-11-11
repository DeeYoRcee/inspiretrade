import { useMemo, useRef, useState } from "react";
import { Award, CalendarDays, ChevronLeft, ChevronRight, FileDown, Gem, ImageDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { useUserProfile } from "@/hooks/use-premium";
import { useTrades } from "@/hooks/use-trades";
import { useLanguage } from "@/lib/language-context";
import { useEconomy, useClaims } from "@/hooks/use-economy";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** YYYY-MM-DD in Asia/Tashkent — must match the reward claim boundary. */
function tashkentDate(ts: number): string {
  return new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Asia/Tashkent" });
}

type DownloadMode = "cert" | "calendar";
type DownloadFormat = "pdf" | "png";

/**
 * Prop-firm style achievement certificate (A4 landscape) rendered from the
 * user's real journal stats + a monthly performance/reward calendar.
 * "PDF" captures the card with html-to-image and wraps it in a single-page
 * A4-landscape jsPDF document; "PNG" downloads the capture directly. Both run
 * fully client-side (lazy-loaded chunks) — no printing, no server roundtrip.
 */
export default function CertificatePage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { toast } = useToast();
  const { data: profile } = useUserProfile();
  const { data: trades } = useTrades();
  const { data: economy } = useEconomy();
  const { data: claims } = useClaims();

  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth()); // 0-11
  const [busy, setBusy] = useState<string | null>(null);
  const certRef = useRef<HTMLDivElement>(null);
  const calendarRef = useRef<HTMLDivElement>(null);

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

  // Days of the selected month on which the user claimed the daily reward.
  const claimedDays = useMemo(() => {
    const set = new Set<number>();
    for (const claim of claims || []) {
      if (!claim?.createdAt) continue;
      const [y, m, d] = tashkentDate(claim.createdAt).split("-").map(Number);
      if (y === calYear && m - 1 === calMonth) set.add(d);
    }
    return set;
  }, [claims, calYear, calMonth]);

  // Real journal PnL per day for the selected month (Tashkent timezone).
  const tradePnlByDay = useMemo(() => {
    const map: Record<number, number> = {};
    for (const trade of trades || []) {
      const [y, m, d] = tashkentDate(trade.timestamp).split("-").map(Number);
      if (y === calYear && m - 1 === calMonth) map[d] = (map[d] || 0) + trade.profit;
    }
    return map;
  }, [trades, calYear, calMonth]);

  const calendarCells = useMemo(() => {
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    // Monday-first weekday index (0 = Monday).
    const firstWeekday = (new Date(calYear, calMonth, 1).getDay() + 6) % 7;
    const cells: (number | null)[] = Array.from({ length: firstWeekday }, () => null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [calYear, calMonth]);

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

  const download = async (mode: DownloadMode, format: DownloadFormat) => {
    const el = mode === "cert" ? certRef.current : calendarRef.current;
    if (!el || busy) return;
    setBusy(`${mode}-${format}`);
    try {
      const [{ toPng }, { jsPDF }] = await Promise.all([
        import("html-to-image"),
        import("jspdf"),
      ]);
      const dataUrl = await toPng(el, { pixelRatio: 2, cacheBust: true });
      const base = mode === "cert" ? `InspireTrade-Certificate-${certId}` : `InspireTrade-Calendar-${certId}-C`;
      if (format === "png") {
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = `${base}.png`;
        a.click();
      } else {
        const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
        pdf.addImage(dataUrl, "PNG", 0, 0, 297, 210);
        pdf.save(`${base}.pdf`);
      }
    } catch {
      toast({ title: t("error"), description: t("certificateNote"), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const shiftMonth = (delta: number) => {
    const d = new Date(calYear, calMonth + delta, 1);
    setCalYear(d.getFullYear());
    setCalMonth(d.getMonth());
  };

  const downloadButton = (mode: DownloadMode, format: DownloadFormat, label: string, variant: "default" | "outline" = "default") => {
    const key = `${mode}-${format}`;
    return (
      <Button size="lg" variant={variant} disabled={!!busy} onClick={() => download(mode, format)} className="rounded-xl font-semibold">
        {busy === key ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : format === "pdf" ? <FileDown className="mr-2 h-5 w-5" /> : <ImageDown className="mr-2 h-5 w-5" />}
        {label}
      </Button>
    );
  };

  return (
    <div className="container mx-auto max-w-5xl space-y-4 p-4 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
            <Award className="h-6 w-6 text-amber-400" />
            {t("certificate")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("certificateSubtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {downloadButton("cert", "pdf", t("certificateDownload"))}
          {downloadButton("cert", "png", "PNG", "outline")}
        </div>
      </div>

      {/* ============ A4 landscape achievement certificate ============ */}
      <div ref={certRef} className="flex justify-center">
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
                    <p className="mt-1 text-[9px] uppercase tracking-[0.25em] text-white/50">CEO &amp; Founder · InspireTrade</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ============ A4 landscape performance / reward calendar ============ */}
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => shiftMonth(-1)} aria-label="Previous month" disabled={!!busy}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-44 text-center text-sm font-semibold">
            {MONTHS_EN[calMonth]} {calYear}
          </span>
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => shiftMonth(1)} aria-label="Next month" disabled={!!busy}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <div className="ml-2 flex flex-wrap gap-2">
            <Button size="sm" disabled={!!busy} onClick={() => download("calendar", "pdf")} className="rounded-xl font-semibold">
              {busy === "calendar-pdf" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileDown className="mr-2 h-4 w-4" />}
              {t("calendarDownload")}
            </Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => download("calendar", "png")} className="rounded-xl font-semibold">
              {busy === "calendar-png" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImageDown className="mr-2 h-4 w-4" />}
              PNG
            </Button>
          </div>
        </div>

        <div ref={calendarRef} className="flex justify-center">
          <div
            className="relative flex aspect-[297/210] w-full max-w-[1000px] flex-col justify-between overflow-hidden rounded-sm p-1"
            style={{ background: "linear-gradient(135deg, #0a0a0a 0%, #141414 55%, #1a1408 100%)" }}
          >
            <div className="absolute inset-0 rounded-sm" style={{ padding: "6px", background: "linear-gradient(120deg, #d4af37, #f5e08a 30%, #a8842a 60%, #f5e08a 85%, #d4af37)" }}>
              <div className="flex h-full w-full flex-col justify-between p-[26px]" style={{ background: "linear-gradient(135deg, #0a0a0a 0%, #141414 55%, #1a1408 100%)" }}>
                {/* header */}
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <img src="/logo.png" alt="InspireTrade" className="h-11 w-auto object-contain" />
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] uppercase tracking-[0.3em] text-[#f5e08a]">Calendar ID</p>
                    <p className="font-mono text-sm font-bold text-[#f5e08a]">{certId}-C</p>
                  </div>
                </div>

                {/* title + weekday grid */}
                <div className="mx-auto w-full max-w-3xl">
                  <div className="text-center">
                    <p className="text-[11px] uppercase tracking-[0.45em] text-[#f5e08a]/80">InspireTrade Performance Calendar</p>
                    <h2
                      className="mt-1 text-3xl font-black uppercase tracking-[0.14em] text-transparent"
                      style={{
                        background: "linear-gradient(120deg, #d4af37, #f9ec9f 40%, #d4af37 70%, #f5e08a)",
                        WebkitBackgroundClip: "text",
                        backgroundClip: "text",
                      }}
                    >
                      {MONTHS_EN[calMonth]} {calYear}
                    </h2>
                  </div>

                  <div className="mt-3 grid grid-cols-7 gap-1.5">
                    {WEEKDAYS.map((day) => (
                      <div key={day} className="py-0.5 text-center text-[10px] font-bold uppercase tracking-widest text-[#f5e08a]/70">
                        {day}
                      </div>
                    ))}
                    {calendarCells.map((day, index) => {
                      if (day === null) return <div key={`empty-${index}`} className="rounded-md border border-transparent" />;
                      const pnl = tradePnlByDay[day];
                      const claimed = claimedDays.has(day);
                      const profit = pnl !== undefined && pnl > 0;
                      const loss = pnl !== undefined && pnl < 0;
                      const color = profit ? "#4ade80" : loss ? "#f87171" : "#f5e08a";
                      return (
                        <div
                          key={`day-${day}`}
                          className="relative flex flex-col items-center justify-center rounded-md border font-mono"
                          style={
                            pnl !== undefined
                              ? {
                                  borderColor: `${color}55`,
                                  background: profit ? "rgba(74,222,128,0.10)" : loss ? "rgba(248,113,113,0.10)" : "rgba(212,175,55,0.10)",
                                }
                              : claimed
                                ? { background: "linear-gradient(135deg, #d4af37, #f5e08a)", borderColor: "transparent" }
                                : { borderColor: "rgba(212,175,55,0.15)", background: "rgba(212,175,55,0.05)" }
                          }
                        >
                          <span className={pnl !== undefined ? "text-[9px] leading-none text-white/55" : claimed ? "text-sm font-bold leading-none text-black" : "text-sm leading-none text-white/45"} style={{ marginTop: pnl !== undefined ? "0" : undefined }}>
                            {day}
                          </span>
                          {pnl !== undefined && (
                            <span className="mt-1 text-[10px] font-bold leading-none sm:text-xs" style={{ color }}>
                              {pnl > 0 ? "+" : ""}{pnl.toFixed(0)}$
                            </span>
                          )}
                          {claimed && <Gem className="absolute right-1 top-1 h-2.5 w-2.5" style={{ color: pnl !== undefined ? "#f5e08a" : "rgba(0,0,0,0.55)" }} />}
                        </div>
                      );
                    })}
                  </div>

                  {/* legend */}
                  <div className="mt-2 flex items-center justify-center gap-4 text-[9px] uppercase tracking-widest text-white/45">
                    <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "rgba(74,222,128,0.25)", border: "1px solid rgba(74,222,128,0.6)" }} />Profit</span>
                    <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "rgba(248,113,113,0.25)", border: "1px solid rgba(248,113,113,0.6)" }} />Loss</span>
                    <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "linear-gradient(135deg, #d4af37, #f5e08a)" }} />{t("calendarLegend")}</span>
                  </div>
                </div>

                {/* footer: name + CEO signature */}
                <div className="flex items-end justify-between">
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.25em] text-white/50">{t("certificatePresentedTo")}</p>
                    <p className="text-lg font-bold text-white">{name}</p>
                    <p className="mt-1 text-[11px] text-[#f5e08a]">{t("certClaimedDays").replace("{n}", String(claimedDays.size))}</p>
                  </div>
                  <div className="text-center">
                    <p
                      className="text-xl italic text-[#f5e08a]"
                      style={{ fontFamily: "'Brush Script MT', 'Segoe Script', cursive" }}
                    >
                      DeeYoRcee_Inspire
                    </p>
                    <div className="mx-auto h-px w-40" style={{ background: "linear-gradient(90deg, transparent, #d4af37, transparent)" }} />
                    <p className="mt-1 text-[9px] uppercase tracking-[0.25em] text-white/50">CEO &amp; Founder · InspireTrade</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <p className="text-center text-xs text-muted-foreground">{t("certificateNote")}</p>
      <p className="text-center text-xs text-muted-foreground">{t("certCalendarSubtitle")}</p>
    </div>
  );
}
