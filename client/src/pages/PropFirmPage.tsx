import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, ArrowRight, BarChart3, ChevronDown, LockKeyhole, Wallet } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type ChallengeType = "1-Step" | "2-Step" | "Instant Funding";
type Challenge = {
  id: string;
  size: number;
  type: ChallengeType;
  price: number;
  phaseOne: number;
  phaseTwo: number | null;
  dailyDrawdown: number;
  maxDrawdown: number;
  profitSplit: number;
  minDays: number;
  periodDays: number;
};

// Illustrative examples only — replace with verified provider terms before enabling sales.
const ACCOUNT_SIZES = [5000, 10000, 25000, 50000, 100000, 200000];
const TYPES: ChallengeType[] = ["1-Step", "2-Step", "Instant Funding"];
const SAMPLE_CHALLENGES: Challenge[] = ACCOUNT_SIZES.flatMap((size) =>
  TYPES.map((type) => {
    const multiplier = size / 10000;
    return {
      id: `${type.toLowerCase().replace(/[^a-z]+/g, "-")}-${size}`,
      size,
      type,
      price: Math.round((type === "1-Step" ? 79 : type === "2-Step" ? 59 : 149) * multiplier),
      phaseOne: type === "2-Step" ? 8 : type === "1-Step" ? 10 : 0,
      phaseTwo: type === "2-Step" ? 5 : null,
      dailyDrawdown: type === "1-Step" ? 4 : 5,
      maxDrawdown: type === "Instant Funding" ? 6 : 10,
      profitSplit: type === "Instant Funding" ? 80 : 90,
      minDays: type === "Instant Funding" ? 0 : 5,
      periodDays: type === "Instant Funding" ? 0 : 30,
    };
  }),
);

const money = (value: number) => `$${value.toLocaleString("en-US")}`;

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5 rounded-lg border border-border/50 bg-card/60 px-2 py-1 text-xs">
      <span className="truncate text-muted-foreground">{label}</span>
      <span className="font-semibold text-foreground">{value}</span>
    </span>
  );
}

function DemoLine() {
  return (
    <p className="mb-5 text-xs text-muted-foreground">
      <span className="font-semibold text-amber-400">Demo only</span> — sample challenges and prices, not real offers. Purchases are coming soon.
    </p>
  );
}

function ChallengeCard({ challenge, onDetails }: { challenge: Challenge; onDetails: () => void }) {
  return (
    <Card className="group border-border/60 bg-background/60 transition-colors hover:border-primary/40">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">{challenge.type}</span>
          <div className="text-right"><p className="text-xs text-muted-foreground">from</p><p className="text-sm font-semibold">{money(challenge.price)}</p></div>
        </div>
        <h3 className="mt-2 text-2xl font-semibold tracking-tight">{money(challenge.size)} <span className="text-sm font-normal text-muted-foreground">account</span></h3>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <StatChip label="Targets" value={challenge.phaseTwo ? `${challenge.phaseOne}% / ${challenge.phaseTwo}%` : challenge.phaseOne ? `${challenge.phaseOne}%` : "—"} />
          <StatChip label="Max DD" value={`${challenge.maxDrawdown}%`} />
          <StatChip label="Daily DD" value={`${challenge.dailyDrawdown}%`} />
          <StatChip label="Split" value={`${challenge.profitSplit}%`} />
        </div>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" className="flex-1 border-border" onClick={onDetails}>Rules <ArrowRight className="h-4 w-4" /></Button>
          <Button className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90" disabled title="Purchases are not available yet"><LockKeyhole className="h-4 w-4" />Soon</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ChallengeDetails({ challenge, onBack }: { challenge: Challenge; onBack: () => void }) {
  const rules: [string, string][] = [
    ["Risk management", `Daily loss limit ${challenge.dailyDrawdown}%, total loss limit ${challenge.maxDrawdown}%.`],
    ["Trading period", challenge.periodDays ? `${challenge.periodDays}-day period, minimum ${challenge.minDays} trading days.` : "No time limit, minimum trading days may apply."],
    ["Profit split", `Up to ${challenge.profitSplit}%.`],
    ["News, weekend & overnight holding", "Policies depend on the provider — confirmed before purchase."],
    ["EA & automated trading", "Requires written approval from the provider."],
  ];
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <Button variant="ghost" onClick={onBack} className="mb-4 gap-2"><ArrowLeft className="h-4 w-4" />Back</Button>
      <DemoLine />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div><p className="mb-1 text-sm text-primary">{challenge.type}</p><h1 className="text-3xl font-semibold sm:text-4xl">{money(challenge.size)} Challenge</h1></div>
        <div className="rounded-xl border border-border/60 bg-card/60 px-4 py-2.5"><p className="text-[11px] text-muted-foreground">Example price</p><p className="text-xl font-semibold">{money(challenge.price)}</p></div>
      </div>
      <div className="mb-6 flex flex-wrap gap-1.5">
        <StatChip label="Phase 1" value={challenge.phaseOne ? `${challenge.phaseOne}%` : "—"} />
        <StatChip label="Phase 2" value={challenge.phaseTwo ? `${challenge.phaseTwo}%` : "—"} />
        <StatChip label="Daily DD" value={`${challenge.dailyDrawdown}%`} />
        <StatChip label="Max DD" value={`${challenge.maxDrawdown}%`} />
        <StatChip label="Split" value={`${challenge.profitSplit}%`} />
        <StatChip label="Min days" value={challenge.minDays ? `${challenge.minDays}` : "—"} />
      </div>
      <section className="space-y-2">
        {rules.map(([title, text]) => (
          <details key={title} className="group rounded-xl border border-border/60 bg-card/60 px-4 py-3">
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium">{title}<ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" /></summary>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{text}</p>
          </details>
        ))}
      </section>
      <p className="mt-6 text-xs text-muted-foreground">All values are illustrative examples — confirm real terms with the provider before any purchase.</p>
    </div>
  );
}

export default function PropFirmPage({ params }: { params?: { challengeId?: string } }) {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"marketplace" | "accounts">("marketplace");
  const [size, setSize] = useState("all");
  const [type, setType] = useState("all");
  const challenge = SAMPLE_CHALLENGES.find((item) => item.id === params?.challengeId);
  const visibleChallenges = useMemo(() => SAMPLE_CHALLENGES.filter((item) =>
    (size === "all" || item.size === Number(size)) &&
    (type === "all" || item.type === type),
  ), [size, type]);

  if (params?.challengeId) {
    return challenge ? <ChallengeDetails challenge={challenge} onBack={() => navigate("/prop-firm")} /> : <div className="mx-auto max-w-4xl p-8"><p>Example challenge not found.</p><Button variant="ghost" onClick={() => navigate("/prop-firm")}>Back to Prop Firm</Button></div>;
  }

  const tabs = [
    { id: "marketplace" as const, label: "Challenges" },
    { id: "accounts" as const, label: "My challenges" },
  ];

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div><p className="mb-1 flex items-center gap-2 text-xs font-semibold tracking-wider text-primary"><BarChart3 className="h-4 w-4" />PROP TRADING</p><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Prop Firm Hub</h1><p className="mt-1 text-sm text-muted-foreground">Pick a challenge format and start your funded journey.</p></div>
          <Link href="/" className="inline-flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Journal</Link>
        </div>
        <DemoLine />

        <div className="mb-5 flex items-center gap-2" role="tablist" aria-label="Prop Firm sections">
          {tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)} className={`rounded-full px-4 py-1.5 text-sm transition-colors ${tab === item.id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"}`}>{item.label}</button>)}
        </div>

        {tab === "marketplace" && <>
          <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-border/60 bg-card/50 p-3">
            <label className="min-w-36 flex-1 text-[11px] text-muted-foreground">Account size<select value={size} onChange={(event) => setSize(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-border/60 bg-background/60 px-2.5 text-sm text-foreground"><option value="all">All</option>{ACCOUNT_SIZES.map((item) => <option key={item} value={item}>{money(item)}</option>)}</select></label>
            <label className="min-w-36 flex-1 text-[11px] text-muted-foreground">Type<select value={type} onChange={(event) => setType(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-border/60 bg-background/60 px-2.5 text-sm text-foreground"><option value="all">All</option>{TYPES.map((item) => <option key={item}>{item}</option>)}</select></label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{visibleChallenges.map((item) => <ChallengeCard key={item.id} challenge={item} onDetails={() => navigate(`/prop-firm/${item.id}`)} />)}</div>
          {visibleChallenges.length === 0 && <div className="rounded-xl border border-border/60 p-8 text-center text-sm text-muted-foreground">No challenges match these filters.</div>}
        </>}

        {tab === "accounts" && <Card className="border-border/60 bg-card/50"><CardContent className="mx-auto max-w-md p-8 text-center sm:p-10"><Wallet className="mx-auto mb-3 h-9 w-9 text-primary" /><h2 className="text-lg font-semibold">No purchased challenges</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{user ? "Your purchased challenges will appear here after a verified payment." : "Sign in to see challenges connected to your account."}</p><Button className="mt-5 bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setTab("marketplace")}>Browse challenges</Button></CardContent></Card>}
      </div>
    </main>
  );
}
