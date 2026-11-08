import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, ArrowRight, BadgeInfo, BarChart3, CalendarDays, Check, ChevronDown, CircleDollarSign, Clock3, Crown, Gauge, LockKeyhole, Shield, Target, Wallet } from "lucide-react";
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

// These are illustrative examples, not real offers. Replace them with verified provider terms before enabling sales.
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

function DemoNotice() {
  return (
    <div className="mb-6 flex gap-3 rounded-xl border border-amber-400/30 bg-amber-400/5 p-4 text-sm" role="note">
      <BadgeInfo className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
      <p className="text-muted-foreground"><strong className="text-foreground">Demo information only.</strong> These sample challenges, prices, targets and rules are illustrative—not real prop-firm offers. Purchases and funded accounts are not available yet.</p>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, note }: { icon: typeof Target; label: string; value: string; note: string }) {
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardContent className="p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between text-sm text-muted-foreground"><span>{label}</span><Icon className="h-4 w-4 text-emerald-400" /></div>
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        <div className="mt-1 text-xs text-muted-foreground">{note}</div>
      </CardContent>
    </Card>
  );
}

function ChallengeCard({ challenge, onDetails }: { challenge: Challenge; onDetails: () => void }) {
  return (
    <Card className="group border-white/10 bg-[#101311] transition-colors hover:border-emerald-400/40">
      <CardContent className="p-5">
        <div className="mb-4 flex items-start justify-between gap-2">
          <div>
            <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-xs font-medium text-emerald-300">{challenge.type}</span>
            <h3 className="mt-3 text-2xl font-semibold">{money(challenge.size)} <span className="text-sm font-normal text-muted-foreground">account</span></h3>
          </div>
          <div className="text-right"><p className="text-xs text-muted-foreground">Example price</p><p className="text-xl font-semibold">{money(challenge.price)}</p></div>
        </div>
        <div className="mb-4 grid grid-cols-2 gap-3 rounded-lg bg-white/[0.03] p-3 text-sm">
          <div><p className="text-xs text-muted-foreground">Phase 1 target</p><p className="mt-1 font-medium">{challenge.phaseOne ? `${challenge.phaseOne}%` : "—"}</p></div>
          <div><p className="text-xs text-muted-foreground">Phase 2 target</p><p className="mt-1 font-medium">{challenge.phaseTwo ? `${challenge.phaseTwo}%` : "Not applicable"}</p></div>
          <div><p className="text-xs text-muted-foreground">Daily drawdown</p><p className="mt-1 font-medium">{challenge.dailyDrawdown}%</p></div>
          <div><p className="text-xs text-muted-foreground">Maximum drawdown</p><p className="mt-1 font-medium">{challenge.maxDrawdown}%</p></div>
          <div><p className="text-xs text-muted-foreground">Profit split</p><p className="mt-1 font-medium">Up to {challenge.profitSplit}%</p></div>
          <div><p className="text-xs text-muted-foreground">Minimum trading days</p><p className="mt-1 font-medium">{challenge.minDays || "None"}</p></div>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">Example terms only · {challenge.periodDays ? `${challenge.periodDays}-day trading period` : "No time limit shown"}</p>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1 border-white/15" onClick={onDetails}>View example rules <ArrowRight className="h-4 w-4" /></Button>
          <Button className="flex-1 bg-emerald-500 text-black hover:bg-emerald-400" disabled title="Purchases are not available yet"><LockKeyhole className="h-4 w-4" />Unavailable</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ChallengeDetails({ challenge, onBack }: { challenge: Challenge; onBack: () => void }) {
  const rules = [
    ["Risk management", `Illustrative only: daily loss limit ${challenge.dailyDrawdown}% and total loss limit ${challenge.maxDrawdown}%. The real provider's calculation method must be confirmed.`],
    ["News trading", "Provider policy not confirmed. Check the actual firm's restricted-news window before trading."],
    ["Weekend holding", "Provider policy not confirmed. Do not assume positions may be held over weekends."],
    ["Overnight holding", "Provider policy not confirmed. Check the actual provider's overnight rules."],
    ["EA and automated trading", "Provider policy not confirmed. Obtain written approval for automated strategies from the actual provider."],
    ["Consistency", "No consistency rule is represented by this demo. Review verified provider terms before purchase."],
    ["Payout conditions", `Example split: up to ${challenge.profitSplit}%. Payout eligibility, schedule, minimum amount and verification are not set.`],
  ];
  const faqs = [
    ["Is this a real challenge?", "No. This is a clearly marked example only and cannot be purchased."],
    ["Will I get a funded account?", "No purchase, payment confirmation, or funded account is being created in this demo."],
    ["Are the rules final?", "No. All values and rule descriptions are illustrative; confirm terms directly with a real provider."],
  ];
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <Button variant="ghost" onClick={onBack} className="mb-6 gap-2"><ArrowLeft className="h-4 w-4" />Back to challenges</Button>
      <DemoNotice />
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div><p className="mb-2 text-sm text-emerald-300">{challenge.type} · illustrative example</p><h1 className="text-3xl font-semibold sm:text-4xl">{money(challenge.size)} Challenge</h1><p className="mt-2 text-muted-foreground">Sample listing—not available for purchase.</p></div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-5 py-3"><p className="text-xs text-muted-foreground">Example price</p><p className="text-2xl font-semibold">{money(challenge.price)}</p></div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Target} label="Phase 1 target" value={challenge.phaseOne ? `${challenge.phaseOne}%` : "—"} note={challenge.type === "Instant Funding" ? "Not applicable" : "Example only"} />
        <StatCard icon={Target} label="Phase 2 target" value={challenge.phaseTwo ? `${challenge.phaseTwo}%` : "—"} note="Example only" />
        <StatCard icon={Gauge} label="Daily drawdown" value={`${challenge.dailyDrawdown}%`} note="Example only" />
        <StatCard icon={Shield} label="Maximum drawdown" value={`${challenge.maxDrawdown}%`} note="Example only" />
      </div>
      <section className="mt-8"><h2 className="mb-4 text-xl font-semibold">Rules and policies</h2><div className="grid gap-3 md:grid-cols-2">{rules.map(([title, text]) => <Card key={title} className="border-white/10 bg-white/[0.03]"><CardContent className="p-5"><h3 className="mb-2 font-medium">{title}</h3><p className="text-sm leading-6 text-muted-foreground">{text}</p></CardContent></Card>)}</div></section>
      <section className="mt-8"><h2 className="mb-4 text-xl font-semibold">Frequently asked questions</h2><div className="space-y-3">{faqs.map(([question, answer]) => <details key={question} className="group rounded-xl border border-white/10 bg-white/[0.03] p-4"><summary className="flex cursor-pointer list-none items-center justify-between font-medium">{question}<ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" /></summary><p className="mt-3 text-sm leading-6 text-muted-foreground">{answer}</p></details>)}</div></section>
    </div>
  );
}

export default function PropFirmPage({ params }: { params?: { challengeId?: string } }) {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"marketplace" | "accounts" | "admin">("marketplace");
  const [size, setSize] = useState("all");
  const [type, setType] = useState("all");
  const [maxPrice, setMaxPrice] = useState("");
  const [minSplit, setMinSplit] = useState("all");
  const challenge = SAMPLE_CHALLENGES.find((item) => item.id === params?.challengeId);
  const visibleChallenges = useMemo(() => SAMPLE_CHALLENGES.filter((item) =>
    (size === "all" || item.size === Number(size)) &&
    (type === "all" || item.type === type) &&
    (!maxPrice || item.price <= Number(maxPrice)) &&
    (minSplit === "all" || item.profitSplit >= Number(minSplit)),
  ), [size, type, maxPrice, minSplit]);

  if (params?.challengeId) {
    return challenge ? <ChallengeDetails challenge={challenge} onBack={() => navigate("/prop-firm")} /> : <div className="mx-auto max-w-4xl p-8"><p>Example challenge not found.</p><Button variant="link" onClick={() => navigate("/prop-firm")}>Back to Prop Firm</Button></div>;
  }

  const tabs = [
    { id: "marketplace" as const, label: "Challenge marketplace" },
    { id: "accounts" as const, label: "My challenges" },
    { id: "admin" as const, label: "Admin" },
  ];

  return (
    <main className="min-h-screen bg-[#080a09] text-white">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
          <div><p className="mb-2 flex items-center gap-2 text-sm font-medium text-emerald-300"><BarChart3 className="h-4 w-4" />PROP TRADING</p><h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Prop Firm Hub</h1><p className="mt-2 text-muted-foreground">Explore challenge formats and keep your funded-trading journey organized.</p></div>
          <Link href="/" className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-sm text-muted-foreground hover:text-white"><ArrowLeft className="h-4 w-4" />Trading journal</Link>
        </div>
        <DemoNotice />
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard icon={BarChart3} label="Sample challenges" value="18" note="Illustrative listings only" />
          <StatCard icon={Wallet} label="Example account sizes" value="6" note="$5K to $200K" />
          <StatCard icon={Target} label="Challenge formats" value="3" note="1-step, 2-step, instant" />
          <StatCard icon={CircleDollarSign} label="Example starting price" value="$29.50" note="Not an offer or live price" />
        </div>
        <div className="mb-6 flex flex-wrap gap-2 border-b border-white/10 pb-3" role="tablist" aria-label="Prop Firm sections">
          {tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)} className={`rounded-lg px-4 py-2 text-sm transition-colors ${tab === item.id ? "bg-emerald-400/10 text-emerald-300" : "text-muted-foreground hover:bg-white/5 hover:text-white"}`}>{item.label}</button>)}
        </div>

        {tab === "marketplace" && <>
          <div className="mb-5 grid gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs text-muted-foreground">Account size<select value={size} onChange={(event) => setSize(event.target.value)} className="mt-2 h-10 w-full rounded-md border border-white/10 bg-[#101311] px-3 text-sm text-white"><option value="all">All sizes</option>{ACCOUNT_SIZES.map((item) => <option key={item} value={item}>{money(item)}</option>)}</select></label>
            <label className="text-xs text-muted-foreground">Challenge type<select value={type} onChange={(event) => setType(event.target.value)} className="mt-2 h-10 w-full rounded-md border border-white/10 bg-[#101311] px-3 text-sm text-white"><option value="all">All types</option>{TYPES.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label className="text-xs text-muted-foreground">Maximum example price<Input type="number" min="0" placeholder="Any price" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} className="mt-2 border-white/10 bg-[#101311]" /></label>
            <label className="text-xs text-muted-foreground">Minimum example profit split<select value={minSplit} onChange={(event) => setMinSplit(event.target.value)} className="mt-2 h-10 w-full rounded-md border border-white/10 bg-[#101311] px-3 text-sm text-white"><option value="all">Any split</option><option value="80">80%+</option><option value="90">90%+</option></select></label>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">Showing {visibleChallenges.length} illustrative examples</p>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visibleChallenges.map((item) => <ChallengeCard key={item.id} challenge={item} onDetails={() => navigate(`/prop-firm/${item.id}`)} />)}</div>
          {visibleChallenges.length === 0 && <div className="rounded-xl border border-white/10 p-10 text-center text-muted-foreground">No sample challenges match these filters.</div>}
        </>}

        {tab === "accounts" && <Card className="border-white/10 bg-white/[0.025]"><CardContent className="mx-auto max-w-xl p-8 text-center sm:p-12"><Wallet className="mx-auto mb-4 h-10 w-10 text-emerald-300" /><h2 className="text-xl font-semibold">No purchased challenges</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{user ? "Your account has no verified Prop Firm purchases. This section will only show challenges after a real payment is verified securely." : "Sign in to see challenges connected to your account."}</p><p className="mt-4 inline-flex items-center gap-2 text-xs text-amber-300"><LockKeyhole className="h-4 w-4" />No demo purchases or payment confirmations are created.</p><Button className="mt-6 bg-emerald-500 text-black hover:bg-emerald-400" onClick={() => setTab("marketplace")}>Browse examples</Button></CardContent></Card>}

        {tab === "admin" && <Card className="border-white/10 bg-white/[0.025]"><CardContent className="mx-auto max-w-xl p-8 text-center sm:p-12"><Shield className="mx-auto mb-4 h-10 w-10 text-emerald-300" /><h2 className="text-xl font-semibold">Admin controls are not configured</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">No admin identity or secure server-side admin authorization is configured in this project. For your security, this page does not allow changes to firms, prices, orders, or payouts.</p><p className="mt-4 text-xs text-muted-foreground">A button or hidden client-side page is not sufficient protection. Admin actions need verified server-side authorization.</p></CardContent></Card>}

        <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/10 pt-5 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" />Periods are examples, not provider terms</span><span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />Payment integration is not active</span><span className="inline-flex items-center gap-1.5"><Check className="h-3.5 w-3.5" />Existing journal and account stay separate</span></div>
      </div>
    </main>
  );
}
