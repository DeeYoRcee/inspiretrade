import { StatsCards } from "@/components/dashboard/StatsCards";
import { TradeTable } from "@/components/trades/TradeTable";
import { AddTradeDialog } from "@/components/trades/AddTradeDialog";
import { WinRateChart } from "@/components/dashboard/WinRateChart";
import { TopCurrencies } from "@/components/dashboard/TopCurrencies";
import { DailyPnLChart } from "@/components/dashboard/DailyPnLChart";
import { DayScreenshotDialog } from "@/components/dashboard/DayScreenshotDialog";
import { Leaderboard } from "@/components/dashboard/Leaderboard";
import { SessionTracker } from "@/components/dashboard/SessionTracker";
import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTrades, useGlobalStats, useSyncUserStats, StatsPeriod } from "@/hooks/use-trades";
import {
  startOfWeek, endOfWeek, startOfMonth, endOfMonth,
  isWithinInterval, isSameDay, format, addDays, isToday
} from "date-fns";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Camera, ChevronLeft, ChevronRight, Globe, Plus, TrendingUp, Users } from "lucide-react";
import { useLanguage } from "@/lib/language-context";

type CalendarView = "monthly" | "weekly";

const EMOTION_MAP: Record<string, string> = {
  happy: ":)",
  neutral: ":|",
  sad: ":(",
};

const EMOTION_COLOR: Record<string, string> = {
  happy: "text-success",
  neutral: "text-yellow-500",
  sad: "text-destructive",
};

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function Dashboard() {
  const { t } = useLanguage();
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [category, setCategory] = useState<string>("ALL");
  const [calendarView, setCalendarView] = useState<CalendarView>("monthly");
  const [screenshotDate, setScreenshotDate] = useState<Date | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [statsPeriod, setStatsPeriod] = useState<StatsPeriod>("allTime");
  const { data: trades } = useTrades();
  const { data: globalStats } = useGlobalStats(statsPeriod);
  const syncStats = useSyncUserStats(trades);

  // Har safar tradelar yuklanganida user statistikasini siteStats/users ga yoz
  useEffect(() => {
    if (trades && trades.length >= 0) {
      syncStats.mutate();
    }
  }, [trades?.length]);

  const filteredTrades = trades?.filter(t => category === "ALL" || t.category === category) || [];

  const weeklyTrades = filteredTrades.filter(t =>
    isWithinInterval(new Date(t.timestamp), {
      start: startOfWeek(new Date(), { weekStartsOn: 1 }),
      end: endOfWeek(new Date(), { weekStartsOn: 1 })
    })
  );

  const monthlyTrades = filteredTrades.filter(t =>
    isWithinInterval(new Date(t.timestamp), {
      start: startOfMonth(new Date()),
      end: endOfMonth(new Date())
    })
  );

  const weeklyPnL = weeklyTrades.reduce((acc, t) => acc + t.profit, 0);
  const monthlyPnL = monthlyTrades.reduce((acc, t) => acc + t.profit, 0);

  const getDayEmotion = (date: Date): string | null => {
    const dayTrades = filteredTrades.filter(t => isSameDay(new Date(t.timestamp), date));
    if (dayTrades.length === 0) return null;
    const withEmotion = dayTrades.filter(t => t.emotion);
    if (withEmotion.length === 0) return null;
    const counts: Record<string, number> = {};
    for (const t of withEmotion) {
      if (t.emotion) counts[t.emotion] = (counts[t.emotion] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  };

  // Weekly view: 7 days starting from Monday of the offset week
  const weekStart = addDays(startOfWeek(new Date(), { weekStartsOn: 1 }), weekOffset * 7);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const handleDayClick = (date: Date | undefined) => {
    if (!date) return;
    setSelectedDate(date);
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl" id="dashboard-root">
      <SessionTracker />
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-8 p-6 rounded-2xl bg-gradient-to-r from-primary/10 to-transparent border-l-4 border-primary shadow-lg"
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-3xl font-display font-bold text-gradient mb-2">{t("overview")}</h2>
            <p className="text-muted-foreground">{t("overviewDescription")}</p>
          </div>
          <Tabs defaultValue="ALL" onValueChange={setCategory} className="w-full md:w-auto">
            <TabsList className="glass-panel border-border/50">
              <TabsTrigger value="ALL">ALL</TabsTrigger>
              <TabsTrigger value="FOREX">FOREX</TabsTrigger>
              <TabsTrigger value="CRYPTO">CRYPTO</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="mt-4 pt-4 border-t border-primary/10">
          <p className="text-sm md:text-base font-medium italic text-primary/80 font-display">
            "Waiting for the right time is just another way of wasting time"
          </p>
        </div>
      </motion.div>

      <StatsCards category={category} />

      {/* Community Win Rate */}
      {(() => {
        const PERIODS: { key: StatsPeriod; label: string }[] = [
          { key: "daily",   label: t("daily") },
          { key: "weekly",  label: t("weekly") },
          { key: "monthly", label: t("monthly") },
          { key: "yearly",  label: t("yearly") },
          { key: "allTime", label: t("allTime") },
        ];
        return (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-6"
          >
            <Card className="glass-panel border-primary/20">
              <CardHeader className="pb-3 pt-4 px-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-primary">
                    <Globe className="w-5 h-5" />
                    <span className="text-sm font-semibold uppercase tracking-wider">{t("communityStats")}</span>
                  </div>
                  {/* Period selector */}
                  <div className="flex gap-1 bg-secondary/60 rounded-lg p-1">
                    {PERIODS.map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => setStatsPeriod(key)}
                        className={cn(
                          "px-2.5 py-1 text-[11px] sm:text-xs rounded-md font-medium transition-all",
                          statsPeriod === key
                            ? "bg-primary text-primary-foreground shadow"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-5 pb-4 pt-0">
                <div className="flex flex-wrap gap-x-6 gap-y-3">
                  {/* Win Rate */}
                  <div className="flex flex-col">
                    <span className="text-xs text-muted-foreground mb-0.5">{t("winRate")}</span>
                    <div className="flex items-baseline gap-1.5">
                      <span className={cn(
                        "text-2xl font-bold font-number",
                        !globalStats || globalStats.totalTrades === 0
                          ? "text-muted-foreground"
                          : parseFloat(globalStats.winRate) >= 50 ? "text-success" : "text-destructive"
                      )}>
                        {globalStats?.winRate ?? "—"}%
                      </span>
                    </div>
                    {/* Win rate bar */}
                    <div className="mt-1.5 h-1.5 w-28 rounded-full bg-secondary overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all duration-500",
                          parseFloat(globalStats?.winRate ?? "0") >= 50 ? "bg-success" : "bg-destructive"
                        )}
                        style={{ width: `${globalStats?.winRate ?? 0}%` }}
                      />
                    </div>
                  </div>

                  <div className="w-px bg-border/40 hidden sm:block" />

                  {/* Total Trades */}
                  <div className="flex flex-col">
                    <span className="text-xs text-muted-foreground mb-0.5">{t("totalTrades")}</span>
                    <span className="text-2xl font-bold font-number">
                      {globalStats?.totalTrades?.toLocaleString() ?? "—"}
                    </span>
                    <div className="mt-1.5 flex gap-2 text-xs">
                      <span className="text-success font-number">✓ {globalStats?.wins ?? 0} {t("wins")}</span>
                      <span className="text-destructive font-number">✗ {globalStats?.losses ?? 0} {t("losses")}</span>
                    </div>
                  </div>

                  <div className="w-px bg-border/40 hidden sm:block" />

                  {/* Active Traders */}
                  <div className="flex flex-col">
                    <span className="text-xs text-muted-foreground mb-0.5">{t("activeTraders")}</span>
                    <div className="flex items-center gap-1.5">
                      <Users className="w-4 h-4 text-muted-foreground" />
                      <span className="text-2xl font-bold font-number">
                        {globalStats?.totalUsers ?? "—"}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground mt-1.5">
                       {statsPeriod === "daily"   && t("today")}
                       {statsPeriod === "weekly"  && t("thisWeek")}
                       {statsPeriod === "monthly" && t("thisMonth")}
                       {statsPeriod === "yearly"  && t("thisYear")}
                       {statsPeriod === "allTime" && t("allTimeLower")}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        );
      })()}

      {/* Win Rate + Top Currencies */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
        <WinRateChart category={category} />
        <TopCurrencies category={category} />
      </div>

      {/* Calendar */}
      <div className="mt-8">
        <Card className="glass-panel w-full">
          <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
             <CardTitle className="text-2xl">{t("tradeCalendar")}</CardTitle>
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex gap-1 bg-secondary/50 rounded-lg p-1">
                <button
                  onClick={() => setCalendarView("monthly")}
                  className={cn(
                    "px-3 py-1 text-xs rounded-md transition-all font-medium",
                    calendarView === "monthly"
                      ? "bg-primary text-primary-foreground shadow"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                   {t("monthlyView")}
                </button>
                <button
                  onClick={() => setCalendarView("weekly")}
                  className={cn(
                    "px-3 py-1 text-xs rounded-md transition-all font-medium",
                    calendarView === "weekly"
                      ? "bg-primary text-primary-foreground shadow"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                   {t("weeklyView")}
                </button>
              </div>
              <div className="flex gap-4">
                <div className="text-right">
                   <p className="text-xs text-muted-foreground">{t("weeklyPnl")}</p>
                  <p className={`text-sm font-bold ${weeklyPnL >= 0 ? 'text-success' : 'text-destructive'}`}>
                    {weeklyPnL >= 0 ? '+' : ''}${weeklyPnL.toLocaleString()}
                  </p>
                </div>
                <div className="text-right">
                   <p className="text-xs text-muted-foreground">{t("monthlyPnl")}</p>
                  <p className={`text-sm font-bold ${monthlyPnL >= 0 ? 'text-success' : 'text-destructive'}`}>
                    {monthlyPnL >= 0 ? '+' : ''}${monthlyPnL.toLocaleString()}
                  </p>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4 sm:p-6">
            {calendarView === "weekly" ? (
              /* ── Custom Weekly View ── */
              <div>
                {/* Navigation */}
                <div className="flex items-center justify-between mb-4">
                  <Button
                    variant="outline" size="sm"
                    onClick={() => setWeekOffset(o => o - 1)}
                    className="gap-1 border-border/50"
                  >
                     <ChevronLeft className="w-4 h-4" /> {t("previous")}
                  </Button>
                  <div className="text-center">
                    <p className="text-sm font-semibold">
                      {format(weekStart, "MMM d")} – {format(addDays(weekStart, 6), "MMM d, yyyy")}
                    </p>
                    {weekOffset !== 0 && (
                      <button
                        onClick={() => setWeekOffset(0)}
                        className="text-xs text-primary hover:underline mt-0.5"
                      >
                         {t("backToThisWeek")}
                      </button>
                    )}
                  </div>
                  <Button
                    variant="outline" size="sm"
                    onClick={() => setWeekOffset(o => o + 1)}
                    disabled={weekOffset >= 0}
                    className="gap-1 border-border/50"
                  >
                     {t("next")} <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>

                {/* Day headers */}
                <div className="grid grid-cols-7 gap-1.5 mb-1.5">
                  {DAY_LABELS.map(d => (
                    <div key={d} className="text-center text-[10px] sm:text-xs font-medium text-muted-foreground py-1">
                      {d}
                    </div>
                  ))}
                </div>

                {/* Day cells */}
                <div className="grid grid-cols-7 gap-1.5">
                  {weekDays.map(date => {
                    const dayTrades = filteredTrades.filter(t => isSameDay(new Date(t.timestamp), date));
                    const dayPnL = dayTrades.reduce((acc, t) => acc + t.profit, 0);
                    const hasTrades = dayTrades.length > 0;
                    const emotion = getDayEmotion(date);
                    const todayDate = isToday(date);
                    const isSelected = selectedDate && isSameDay(date, selectedDate);

                    return (
                      <button
                        key={date.toISOString()}
                        onClick={() => handleDayClick(date)}
                        className={cn(
                          "relative h-20 sm:h-24 rounded-lg flex flex-col items-center justify-between p-1.5 sm:p-2 transition-all text-left",
                          isSelected && "ring-2 ring-primary ring-offset-1 ring-offset-background",
                          todayDate && !isSelected && "bg-accent/60",
                          hasTrades && dayPnL > 0
                            ? "border-2 border-success/80 shadow-[0_0_8px_rgba(34,197,94,0.25)]"
                            : hasTrades && dayPnL < 0
                              ? "border-2 border-destructive/80 shadow-[0_0_8px_rgba(239,68,68,0.25)]"
                              : "border border-border/30 hover:border-border/60"
                        )}
                      >
                        <div className="flex flex-col items-center gap-0.5 w-full">
                          <span className={cn(
                            "text-[10px] font-medium",
                            todayDate ? "text-primary" : "text-muted-foreground"
                          )}>
                            {format(date, "d")}
                          </span>
                          {todayDate && (
                            <span className="w-1 h-1 rounded-full bg-primary" />
                          )}
                        </div>
                        {hasTrades && (
                          <span className={cn(
                            "text-[9px] sm:text-[10px] font-bold leading-none font-number",
                            dayPnL > 0 ? "text-success" : dayPnL < 0 ? "text-destructive" : "text-muted-foreground"
                          )}>
                            {dayPnL > 0 ? "+" : ""}{dayPnL.toFixed(0)}$
                          </span>
                        )}
                        {!hasTrades && (
                          <span className="text-[8px] text-muted-foreground/40">{format(date, "MMM")}</span>
                        )}
                        {emotion && (
                          <span className={cn(
                            "absolute bottom-0.5 right-0.5 text-[9px] sm:text-[10px] font-bold font-mono",
                            EMOTION_COLOR[emotion]
                          )}>
                            {EMOTION_MAP[emotion]}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Screenshot button */}
                {selectedDate && (
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    <AddTradeDialog
                      defaultDate={selectedDate}
                      trigger={
                        <Button variant="default" size="sm" className="gap-2">
                          <Plus className="w-4 h-4" />
                          {t("logNewTrade")} — {format(selectedDate, "MMM d")}
                        </Button>
                      }
                    />
                    <Button
                      variant="outline" size="sm"
                      onClick={() => setScreenshotDate(selectedDate)}
                      className="gap-2 text-muted-foreground hover:text-foreground border-border/50"
                    >
                      <Camera className="w-4 h-4" />
                       {format(selectedDate, "MMM d")} — {t("viewAddScreenshot")}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              /* ── Monthly Calendar View ── */
              <>
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={handleDayClick}
                  className="w-full rounded-md border-none flex justify-center"
                  classNames={{
                    months: "w-full space-y-4",
                    month: "w-full space-y-4",
                    table: "w-full border-collapse space-y-1",
                    head_row: "flex w-full",
                    head_cell: "text-muted-foreground rounded-md w-full font-normal text-[0.8rem]",
                    row: "flex w-full mt-2",
                    cell: "relative p-0 text-center text-sm focus-within:relative focus-within:z-20 w-full h-14 sm:h-20",
                    day: "h-full w-full p-0 font-normal aria-selected:opacity-100 hover:bg-accent rounded-md transition-colors flex flex-col items-center justify-start py-1",
                    day_selected: "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground",
                    day_today: "bg-accent text-accent-foreground",
                    day_outside: "text-muted-foreground opacity-50",
                    day_disabled: "text-muted-foreground opacity-50",
                    day_range_middle: "aria-selected:bg-accent aria-selected:text-accent-foreground",
                    day_hidden: "invisible",
                  }}
                  modifiers={{
                    profit: (date) => {
                      const dayTrades = filteredTrades.filter(t => isSameDay(new Date(t.timestamp), date));
                      return dayTrades.length > 0 && dayTrades.reduce((acc, t) => acc + t.profit, 0) > 0;
                    },
                    loss: (date) => {
                      const dayTrades = filteredTrades.filter(t => isSameDay(new Date(t.timestamp), date));
                      return dayTrades.length > 0 && dayTrades.reduce((acc, t) => acc + t.profit, 0) < 0;
                    },
                  }}
                  modifiersClassNames={{
                    profit: "!bg-transparent !text-success font-bold",
                    loss: "!bg-transparent !text-destructive font-bold",
                  }}
                  components={{
                    DayContent: ({ date }) => {
                      const dayTrades = filteredTrades.filter(t => isSameDay(new Date(t.timestamp), date));
                      const dayPnL = dayTrades.reduce((acc, t) => acc + t.profit, 0);
                      const hasTrades = dayTrades.length > 0;
                      const emotion = getDayEmotion(date);

                      return (
                        <div className={cn(
                          "flex flex-col items-center justify-between h-full w-full py-1 rounded-md transition-colors relative",
                          hasTrades && dayPnL > 0
                            ? "border-2 border-success/80 shadow-[0_0_10px_rgba(34,197,94,0.3)]"
                            : hasTrades && dayPnL < 0
                              ? "border-2 border-destructive/80 shadow-[0_0_10px_rgba(239,68,68,0.3)]"
                              : "border border-border/20"
                        )}>
                          <span className="font-medium text-xs sm:text-sm">{format(date, "d")}</span>
                          {hasTrades && (
                            <span className={cn(
                              "text-[9px] sm:text-[10px] font-bold leading-none",
                              dayPnL > 0 ? "text-success" : dayPnL < 0 ? "text-destructive" : "text-muted-foreground"
                            )}>
                              {dayPnL > 0 ? "+" : ""}{dayPnL.toFixed(0)}$
                            </span>
                          )}
                          {emotion && (
                            <span className={cn(
                              "absolute bottom-0.5 right-0.5 text-[9px] sm:text-[10px] font-bold font-mono leading-none",
                              EMOTION_COLOR[emotion]
                            )}>
                              {EMOTION_MAP[emotion]}
                            </span>
                          )}
                        </div>
                      );
                    },
                  }}
                />

                {selectedDate && (
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    <AddTradeDialog
                      defaultDate={selectedDate}
                      trigger={
                        <Button variant="default" size="sm" className="gap-2">
                          <Plus className="w-4 h-4" />
                          {t("logNewTrade")} — {format(selectedDate, "MMM d")}
                        </Button>
                      }
                    />
                    <Button
                      variant="outline" size="sm"
                      onClick={() => setScreenshotDate(selectedDate)}
                      className="gap-2 text-muted-foreground hover:text-foreground border-border/50"
                    >
                      <Camera className="w-4 h-4" />
                       {format(selectedDate, "MMM d")} — {t("viewAddScreenshot")}
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Daily PnL + Leaderboard */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
        <div className="lg:col-span-2">
          <DailyPnLChart category={category} />
        </div>
        <div>
          <Leaderboard period={statsPeriod} />
        </div>
      </div>

      {/* Trade History */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="w-full mt-8"
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-display font-bold text-foreground">{t("tradeHistory")}</h2>
          <AddTradeDialog />
        </div>
        <TradeTable category={category} />
      </motion.div>

      {/* Screenshot Dialog */}
      <DayScreenshotDialog
        date={screenshotDate}
        onClose={() => setScreenshotDate(null)}
      />
    </div>
  );
}
