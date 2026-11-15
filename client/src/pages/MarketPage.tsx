import { useMemo, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { useMutation } from "@tanstack/react-query";
import { Coins, Store, Tag, XCircle, ShoppingBag, Info, Crown, Gem, Box } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { authedFetch } from "@/lib/api";
import { useEconomy, useInventory, useEconomyInvalidator, useCustomCases, type CustomCaseDef } from "@/hooks/use-economy";
import { useMarketListings, type MarketListing } from "@/hooks/use-market";
import { FragmentCard } from "@/components/rewards/FragmentCard";
import { ALL_FRAGMENTS, getFragment, CASES, MARKET_FEE_PERCENT, MIN_LISTING_PRICE, MAX_LISTING_PRICE, sellerReceives, type FragmentDef } from "@shared/fragments";
import { cn } from "@/lib/utils";

export default function MarketPage() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { data: economy } = useEconomy();
  const { data: inventory } = useInventory();
  const { data: listings } = useMarketListings();
  const invalidate = useEconomyInvalidator();

  const coins = economy?.coins ?? 0;
  const { data: customCases } = useCustomCases();
  // "f:<fragmentId>" or "c:<caseId>" — one selector sells fragments AND cases
  const [sellItem, setSellItem] = useState<string>("");
  const [sellPrice, setSellPrice] = useState<string>("");

  const ownedSellable = useMemo(
    () => ALL_FRAGMENTS.filter((f) => (inventory?.[f.id] || 0) >= 1),
    [inventory],
  );

  // owned cases of every kind: the two built-ins + the owner's custom cases
  const ownedCases: { caseId: string; name: string; count: number; isGold: boolean; def?: CustomCaseDef }[] = useMemo(() => {
    const list: { caseId: string; name: string; count: number; isGold: boolean; def?: CustomCaseDef }[] = [];
    if ((economy?.cases ?? 0) > 0) list.push({ caseId: "inspire", name: CASES.inspire.name, count: economy!.cases, isGold: false });
    if ((economy?.goldCases ?? 0) > 0) list.push({ caseId: "gold", name: CASES.gold.name, count: economy!.goldCases, isGold: true });
    for (const def of customCases ?? []) {
      const count = economy?.customCases?.[def.caseId] ?? 0;
      if (count > 0) list.push({ caseId: def.caseId, name: def.name, count, isGold: false, def });
    }
    return list;
  }, [economy, customCases]);

  const listMutation = useMutation({
    mutationFn: async () => {
      const price = Number(sellPrice);
      if (sellItem.startsWith("c:")) {
        return authedFetch("/api/market?action=list", { kind: "case", caseId: sellItem.slice(2), price });
      }
      return authedFetch("/api/market?action=list", { fragmentId: sellItem.slice(2), price });
    },
    onSuccess: () => {
      toast({ title: t("listingCreated") });
      setSellItem("");
      setSellPrice("");
      invalidate();
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (listingId: string) => authedFetch("/api/market?action=cancel", { listingId }),
    onSuccess: () => {
      toast({ title: t("listingCanceled") });
      invalidate();
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const buyMutation = useMutation({
    mutationFn: async (listingId: string) => authedFetch("/api/market?action=buy", { listingId }),
    onSuccess: () => {
      toast({ title: t("purchaseSuccess") });
      invalidate();
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const myListings = (listings || []).filter((listing) => listing.isOwn);

  // Prices are decimal INSP with up to 2 decimals (e.g. 0.03).
  const rawPrice = Number(sellPrice);
  const parsedPrice = Math.round(rawPrice * 100) / 100;
  const priceValid =
    sellPrice.trim() !== "" &&
    Number.isFinite(rawPrice) &&
    Math.abs(rawPrice - parsedPrice) < 1e-9 &&
    parsedPrice >= MIN_LISTING_PRICE &&
    parsedPrice <= MAX_LISTING_PRICE;
  const receive = priceValid ? sellerReceives(parsedPrice) : 0;

  return (
    <div className="container mx-auto max-w-5xl space-y-6 p-4 sm:px-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t("market")}</h1>
          <p className="text-sm text-muted-foreground">{t("marketSubtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5 rounded-full border-border/60 bg-card/60 px-3 py-1.5 text-sm font-bold text-amber-400">
            <Coins className="h-4 w-4" /> {coins} INSP
          </Badge>
          <span className="text-xs text-muted-foreground">1 INSP = $1</span>
        </div>
      </div>

      <Tabs defaultValue="market">
        <TabsList className="glass-panel rounded-full border border-border/60">
          <TabsTrigger value="market" className="gap-1.5 rounded-full"><Store className="h-4 w-4" />{t("marketTab")}</TabsTrigger>
          <TabsTrigger value="mine" className="gap-1.5 rounded-full"><ShoppingBag className="h-4 w-4" />{t("myListings")}</TabsTrigger>
        </TabsList>

        {/* Marketplace */}
        <TabsContent value="market" className="mt-4">
          {!listings?.length ? (
            <Card className="glass-panel border-border/50">
              <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
                <Store className="h-10 w-10 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">{t("noListings")}</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {listings.map((listing) => (
                <motion.div key={listing.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-2">
                  {listing.kind === "case" ? (
                    <CaseListCard listing={listing} customCases={customCases}>
                      <div className="mt-3 w-full space-y-2 text-left">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span className="max-w-[120px] truncate">@{listing.sellerName}</span>
                          <span className="font-number font-bold text-amber-400">{listing.price} INSP</span>
                        </div>
                        <ListingAction
                          listing={listing}
                          coins={coins}
                          buyMutation={buyMutation}
                          t={t}
                        />
                      </div>
                    </CaseListCard>
                  ) : (
                    <FragmentCard
                      fragmentId={listing.fragmentId}
                      className="flex-1"
                      footer={
                        <div className="mt-3 w-full space-y-2 text-left">
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span className="max-w-[120px] truncate">@{listing.sellerName}</span>
                            <span className="font-number font-bold text-amber-400">{listing.price} INSP</span>
                          </div>
                          <ListingAction
                            listing={listing}
                            coins={coins}
                            buyMutation={buyMutation}
                            t={t}
                          />
                        </div>
                      }
                    />
                  )}
                </motion.div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* My listings + sell form */}
        <TabsContent value="mine" className="mt-4 space-y-6">
          <Card className="glass-panel border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg"><Tag className="h-5 w-5 text-primary" />{t("sellTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {ownedSellable.length === 0 && ownedCases.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("nothingToSell")}</p>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">{t("selectSellItem")}</label>
                      <Select value={sellItem} onValueChange={setSellItem}>
                        <SelectTrigger className="w-full rounded-xl"><SelectValue placeholder={t("selectSellItem")} /></SelectTrigger>
                        <SelectContent className="glass-panel border-border/60">
                          {ownedCases.map((c) => (
                            <SelectItem key={`c-${c.caseId}`} value={`c:${c.caseId}`}>
                              {c.name} ×{c.count}
                            </SelectItem>
                          ))}
                          {ownedSellable.map((fragment) => (
                            <SelectItem key={`f-${fragment.id}`} value={`f:${fragment.id}`}>
                              {fragment.name} ×{inventory?.[fragment.id]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">{t("priceLabel")}</label>
                      <Input
                        type="number"
                        min={MIN_LISTING_PRICE}
                        max={MAX_LISTING_PRICE}
                        step={0.01}
                        value={sellPrice}
                        onChange={(e) => setSellPrice(e.target.value)}
                        placeholder="0.03"
                        className="rounded-xl"
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-xl border border-border/50 bg-card/50 px-4 py-2.5 text-sm">
                    <span className="flex items-center gap-1.5 text-muted-foreground"><Info className="h-4 w-4" />{t("youReceive")}</span>
                    <span className="font-number font-bold text-amber-400">{receive || "—"} INSP</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("marketFeeNote").replace("{fee}", String(MARKET_FEE_PERCENT))}</p>
                  <Button
                    className="w-full rounded-xl font-semibold"
                    disabled={!sellItem || !priceValid || listMutation.isPending}
                    onClick={() => listMutation.mutate()}
                  >
                    {listMutation.isPending ? t("listing") : t("listForSale")}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          {/* My active listings */}
          <Card className="glass-panel border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">{t("myListings")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {!myListings.length ? (
                <p className="py-4 text-center text-sm text-muted-foreground">{t("noOwnListings")}</p>
              ) : (
                myListings.map((listing) => {
                  const label = listing.kind === "case"
                    ? listing.itemName || (listing.caseId === "inspire" ? CASES.inspire.name : listing.caseId === "gold" ? CASES.gold.name : customCases?.find((c) => c.caseId === listing.caseId)?.name || listing.caseId)
                    : getFragment(listing.fragmentId)?.name || listing.fragmentId;
                  return (
                    <div key={listing.id} className="flex items-center justify-between rounded-xl border border-border/50 bg-card/50 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{label}</p>
                        <p className="font-number text-xs text-amber-400">{listing.price} INSP</p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full"
                        disabled={cancelMutation.isPending}
                        onClick={() => cancelMutation.mutate(listing.id)}
                      >
                        <XCircle className="mr-1 h-4 w-4" />{t("cancelListing")}
                      </Button>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Market card for a CASE listing (Inspire / Gold / custom) — mirrors FragmentCard's look. */
function CaseListCard({ listing, customCases, children }: {
  listing: MarketListing;
  customCases?: CustomCaseDef[];
  children?: ReactNode;
}) {
  const { t } = useLanguage();
  const isGold = listing.caseId === "gold";
  const isBuiltin = listing.caseId === "inspire" || listing.caseId === "gold";
  const def = customCases?.find((c) => c.caseId === listing.caseId);
  const name = listing.itemName
    || (isBuiltin ? CASES[listing.caseId as "inspire" | "gold"].name : def?.name || listing.caseId || "");
  const fragmentCount = isBuiltin
    ? CASES[listing.caseId as "inspire" | "gold"].fragments.length
    : def?.fragments.length;
  return (
    <Card className={cn(
      "glass-panel flex flex-1 flex-col items-center justify-center gap-2 border py-6",
      isGold ? "border-amber-500/40" : listing.caseId === "inspire" ? "border-primary/30" : "border-sky-500/40",
    )}>
      <CardContent className="flex flex-col items-center gap-2 py-0">
        <div className={cn(
          "flex h-16 w-16 items-center justify-center rounded-2xl border",
          isGold
            ? "border-amber-500/40 bg-gradient-to-br from-amber-500/25 via-amber-500/5 to-transparent"
            : listing.caseId === "inspire"
              ? "border-primary/30 bg-gradient-to-br from-primary/20 via-primary/5 to-transparent"
              : "border-sky-500/40 bg-gradient-to-br from-sky-500/25 via-sky-500/5 to-transparent",
        )}>
          {isGold ? <Crown className="h-7 w-7 text-amber-400" /> : listing.caseId === "inspire" ? <Gem className="h-7 w-7 text-primary" /> : <Box className="h-7 w-7 text-sky-400" />}
        </div>
        <p className="max-w-[180px] truncate text-sm font-semibold">{name}</p>
        <Badge variant="outline" className="rounded-full border-border/60 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {t("caseBadge")} {fragmentCount ? `· ${fragmentCount}` : ""}
        </Badge>
        {children}
      </CardContent>
    </Card>
  );
}

function ListingAction({ listing, coins, buyMutation, t }: {
  listing: MarketListing;
  coins: number;
  buyMutation: any;
  t: (key: string) => string;
}) {
  const isOwn = listing.isOwn === true;
  const insufficient = coins < listing.price;
  if (isOwn) {
    return (
      <Button variant="secondary" size="sm" className="w-full rounded-xl" disabled>
        {t("ownListing")}
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      className="w-full rounded-xl font-semibold"
      disabled={insufficient || buyMutation.isPending}
      onClick={() => buyMutation.mutate(listing.id)}
    >
      {insufficient ? t("insufficientCoins") : <><Coins className="mr-1.5 h-4 w-4" />{t("buyButton")}</>}
    </Button>
  );
}
