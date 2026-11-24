/**
 * P74 — FREE-keyword SEO landing pages (public, no auth).
 *
 * Two pages, both describing REAL product features only (the P74 audit found
 * no premium gate on any terminal/journal component — core tools are free;
 * Premium buys community perks only; prop-firm purchases are marked
 * "demo / coming soon", so NO free-funded-account claims anywhere):
 *   /free-trading-terminal  — the trading terminal
 *   /free-trading-journal   — the trade journal
 *
 * Each page: one H1, real feature copy, an honest "free vs Premium" block,
 * limitations, FAQ (+ FAQPage JSON-LD rendered from the same list), internal
 * links and a signup CTA. Head metadata via seo.ts (self-canonical).
 */
import { useEffect } from "react";
import { Link } from "wouter";
import { applySeo } from "@/lib/seo";
import { CandlestickChart, BookOpen, ArrowRight, CheckCircle2, ShieldCheck, Smartphone, Activity } from "lucide-react";

const SITE = "https://inspiretrade.site";

interface FaqItem { q: string; a: string }

function LandingShell({
  path,
  title,
  description,
  appName,
  children,
  faq,
  crossLink,
}: {
  path: string;
  title: string;
  description: string;
  appName: string;
  children: React.ReactNode;
  faq: FaqItem[];
  crossLink: { href: string; label: string };
}) {
  useEffect(() => { applySeo({ title, description, path }); }, [title, description, path]);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
          }),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: appName,
            url: `${SITE}${path}`,
            applicationCategory: "FinanceApplication",
            operatingSystem: "Web",
            offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          }),
        }}
      />

      {/* header — logo + signup CTA */}
      <header className="sticky top-0 z-40 border-b border-border/50 bg-background/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="flex items-center gap-2"><img src="/logo.png" alt="InspireTrade" className="h-8 w-auto object-contain" /></Link>
          <Link href="/" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90">
            Create a free account <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-16 pt-10 sm:px-6">
        {children}

        {/* FAQ — visible copy and the FAQPage JSON-LD render from one list */}
        <section className="mt-12">
          <h2 className="font-display text-2xl font-semibold tracking-tight">Frequently asked questions</h2>
          <dl className="mt-4 space-y-4">
            {faq.map((f) => (
              <div key={f.q}>
                <dt className="font-medium text-foreground">{f.q}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* signup CTA */}
        <section className="mt-12 rounded-3xl border border-primary/25 bg-card/60 p-6 text-center sm:p-8">
          <h2 className="font-display text-xl font-semibold tracking-tight">Ready to try it?</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">A free account takes a minute — no credit card, no download. Everything on this page works in the browser.</p>
          <Link href="/" className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-6 font-semibold text-primary-foreground transition-colors hover:bg-primary/90">Open InspireTrade free <ArrowRight className="h-4 w-4" /></Link>
        </section>

        {/* internal links */}
        <footer className="mt-12 border-t border-border/50 pt-6 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Keep exploring:</p>
          <ul className="mt-2 space-y-1.5">
            <li><Link className="text-[#3390ec] hover:underline" href={crossLink.href}>{crossLink.label}</Link></li>
            <li><Link className="text-[#3390ec] hover:underline" href="/">InspireTrade home — everything about trading in one place</Link></li>
          </ul>
          <p className="mt-5 text-xs text-muted-foreground/70">InspireTrade provides analysis tools and market data for personal use — not investment advice.</p>
        </footer>
      </main>
    </div>
  );
}

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      <span className="text-sm leading-relaxed text-muted-foreground">{children}</span>
    </li>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="font-display text-2xl font-semibold tracking-tight">{children}</h2>;
}

// ---------------------------------------------------------------------------
// /free-trading-terminal
// ---------------------------------------------------------------------------
const TERMINAL_FAQ: FaqItem[] = [
  { q: "Is the trading terminal really free?", a: "Yes. Create a free account and the terminal opens with all charts, drawing tools, workspaces, alerts and the journal — no payment and no credit card. An optional Premium subscription adds community perks, not core tools." },
  { q: "Which markets can I chart?", a: "Forex majors and minors, metals (a self-recorded Spot Gold and Spot Silver engine), crypto from Binance and stock indices — all from real market data providers." },
  { q: "Is the market data real-time?", a: "Crypto streams live from Binance. Forex majors poll at a 2-second cadence with the measured provider delay shown honestly on the status badge — some providers are deliberately labelled as delayed rather than pretending to be tick-real-time." },
  { q: "Do I need to install anything?", a: "No. The terminal runs in the browser on any device. If you like it, you can install it as an app (PWA) on Android, iOS and desktop." },
  { q: "Can I practice prop firm challenges here?", a: "You can track practice challenges with the free prop firm tools. InspireTrade does not sell challenge accounts and does not offer free funded accounts — any purchase option shown is clearly marked as a demo until it launches." },
];

export function FreeTerminalLanding() {
  return (
    <LandingShell
      path="/free-trading-terminal"
      title="Free Trading Terminal — Charts, Drawing Tools & Workspaces | InspireTrade"
      description="A free online trading terminal: multi-chart workspaces, drawing and position-sizing tools, alerts, replay and live forex, crypto and metals data. No credit card — free to start."
      appName="InspireTrade Trading Terminal"
      crossLink={{ href: "/free-trading-journal", label: "Free forex trading journal — track every trade" }}
      faq={TERMINAL_FAQ}
    >
      <p className="text-sm font-semibold uppercase tracking-wider text-primary">Free trading tools</p>
      <h1 className="mt-2 font-display text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">A free trading terminal with real market data</h1>
      <p className="mt-4 text-base leading-relaxed text-muted-foreground">
        InspireTrade's terminal is a browser-based charting and analysis workspace for forex, crypto and metals traders. Everything below is included in the free plan — the tools are not locked behind a subscription.
      </p>

      <section className="mt-10">
        <H2>What you get, free</H2>
        <ul className="mt-4 space-y-2.5">
          <Feature><b>Multi-chart workspaces</b> — run 1 to 6 charts side by side, resize panes, save your layout and restore it later; workspaces export and import as JSON.</Feature>
          <Feature><b>Drawing toolkit</b> — trend lines, Fibonacci retracements, shapes, text and dedicated position-sizing tools, with an object manager that supports groups, lock, hide and search.</Feature>
          <Feature><b>Live market data</b> — forex majors, Spot Gold and Spot Silver, crypto from Binance and indices, with an honest status badge that names each provider and its delay.</Feature>
          <Feature><b>Price alerts and an economic calendar</b> — per-instrument alerts at specific times, calendar events with pre-event reminders, and a market news feed.</Feature>
          <Feature><b>Replay mode</b> — step back through history and walk the chart forward bar by bar to practice your entries.</Feature>
          <Feature><b>Installable app</b> — the terminal installs as a PWA on Android, iOS and desktop with your settings kept between sessions.</Feature>
        </ul>
      </section>

      <section className="mt-10">
        <H2>How the free data works</H2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          InspireTrade does not generate prices. Forex majors fold the live interbank bid into the chart tail on a short polling cadence; crypto streams from Binance; Spot Gold and Spot Silver build from a self-recorded 1-second quote engine with Twelve Data backfill for history. Where a provider is delayed, the chart says so on its badge — the delay is shown, never hidden.
        </p>
      </section>

      <section className="mt-10">
        <H2>Free vs Premium — no bait</H2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          The terminal, journal, alerts, calendar and prop firm tracking do not require Premium. The optional Premium subscription (managed through Whop) adds community perks: leaderboard visibility, a Premium profile badge and priority support. If that ever changes, this page will say so.
        </p>
      </section>

      <section className="mt-10">
        <H2>Prop firm tools — free tracking, honest about the rest</H2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          You can track practice prop firm challenges for free with monitoring dashboards and trade-level breakdowns. InspireTrade does not sell funded challenges today (purchase flows are marked "demo — coming soon") and does not offer free funded accounts. We only target what genuinely exists.
        </p>
      </section>

      <section className="mt-10 grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-border/50 bg-card/40 p-4"><CandlestickChart className="h-5 w-5 text-primary" /><p className="mt-2 text-sm font-medium">Real candles, real providers</p></div>
        <div className="rounded-2xl border border-border/50 bg-card/40 p-4"><ShieldCheck className="h-5 w-5 text-primary" /><p className="mt-2 text-sm font-medium">Delays shown honestly</p></div>
        <div className="rounded-2xl border border-border/50 bg-card/40 p-4"><Smartphone className="h-5 w-5 text-primary" /><p className="mt-2 text-sm font-medium">Browser-first, installable</p></div>
      </section>
    </LandingShell>
  );
}

// ---------------------------------------------------------------------------
// /free-trading-journal
// ---------------------------------------------------------------------------
const JOURNAL_FAQ: FaqItem[] = [
  { q: "Is the trading journal free?", a: "Yes. The trade log, statistics, calendar and public profile are part of the free plan. Premium is optional and only adds community perks like leaderboard visibility." },
  { q: "What statistics does the journal calculate?", a: "Total trades, win rate, net P&L, streaks and per-instrument breakdowns, plus a month-by-month calendar that shows each day's profit or loss." },
  { q: "Which markets does it support?", a: "Forex, crypto, metals and indices — the same instruments as the terminal, so a chart and its journal entry always refer to the same market." },
  { q: "Is my trading data private?", a: "Your journal is private by default. You choose whether to publish a public trading profile, and the bio and stats you share are exactly the ones you enable." },
  { q: "Can I share my results?", a: "Yes — each trader with a username gets a shareable public profile page (inspiretrade.site/@yourname) showing the stats you chose to publish." },
];

export function FreeJournalLanding() {
  return (
    <LandingShell
      path="/free-trading-journal"
      title="Free Forex Trading Journal — Track Every Trade | InspireTrade"
      description="A free trading journal for forex and crypto: log trades, win rate, net P&L, streaks, a P&L calendar and a shareable public trading profile. Free to start, no credit card."
      appName="InspireTrade Trading Journal"
      crossLink={{ href: "/free-trading-terminal", label: "Free online trading terminal — charts and drawing tools" }}
      faq={JOURNAL_FAQ}
    >
      <p className="text-sm font-semibold uppercase tracking-wider text-primary">Free trading tools</p>
      <h1 className="mt-2 font-display text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">A free forex trading journal that does the math for you</h1>
      <p className="mt-4 text-base leading-relaxed text-muted-foreground">
        Log your trades once — InspireTrade keeps the score. Win rate, net P&amp;L, streaks and a calendar of your best and worst days, for personal accounts and prop firm practice alike. The journal is part of the free plan.
      </p>

      <section className="mt-10">
        <H2>What you get, free</H2>
        <ul className="mt-4 space-y-2.5">
          <Feature><b>Trade log</b> — record entries with instrument, direction, size, entry, exit and notes; edit or remove mistakes anytime.</Feature>
          <Feature><b>Automatic statistics</b> — total trades, win rate with a progress ring, net P&amp;L and current streak, updated as you log.</Feature>
          <Feature><b>Trading calendar</b> — a month-by-month calendar that colours each day by its profit or loss, so patterns jump out.</Feature>
          <Feature><b>Titles and certificates</b> — earn recognition titles and generate a trading certificate from your verified results.</Feature>
          <Feature><b>Shareable public profile</b> — publish the stats you choose at inspiretrade.site/@yourname; everything stays private until you switch it on.</Feature>
          <Feature><b>Journal + terminal together</b> — the same instruments feed both, so reviews line up with the charts you traded on.</Feature>
        </ul>
      </section>

      <section className="mt-10">
        <H2>Built for prop firm routines too</H2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Working through a prop firm challenge? The journal keeps your rules measurable: daily loss limits become visible on the calendar, and the practice challenge tracker (free) stores each attempt with its own dashboard. We do not sell challenges or promise funded accounts — purchases shown anywhere are explicitly marked as demo until they launch.
        </p>
      </section>

      <section className="mt-10">
        <H2>Free vs Premium</H2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          The journal, statistics, calendar and profile are free. Premium (optional, via Whop) adds leaderboard visibility, a Premium badge and priority support — never a paywall on your own trading data.
        </p>
      </section>

      <section className="mt-10 grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-border/50 bg-card/40 p-4"><BookOpen className="h-5 w-5 text-primary" /><p className="mt-2 text-sm font-medium">Log once, stats forever</p></div>
        <div className="rounded-2xl border border-border/50 bg-card/40 p-4"><Activity className="h-5 w-5 text-primary" /><p className="mt-2 text-sm font-medium">Win rate & P&L calendar</p></div>
        <div className="rounded-2xl border border-border/50 bg-card/40 p-4"><ShieldCheck className="h-5 w-5 text-primary" /><p className="mt-2 text-sm font-medium">Private by default</p></div>
      </section>
    </LandingShell>
  );
}
