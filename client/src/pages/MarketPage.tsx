import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useMutation } from "@tanstack/react-query";
import { Coins, Store, Tag, XCircle, ShoppingBag, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { authedFetch } from "@/lib/api";
import { useEconomy, useInventory, useEconomyInvalidator } from "@/hooks/use-economy";
import { useMarketListings, type MarketListing } from "@/hooks/use-market";
import { FragmentCard } from "@/components/rewards/FragmentCard";
import { FRAGMENTS, getFragment, MARKET_FEE_PERCENT, MIN_LISTING_PRICE, MAX_LISTING_PRICE, sellerReceives } from "@shared/fragments";

export default function MarketPage() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { data: economy } = useEconomy();
  const { data: inventory } = useInventory();
  const { data: listings } = useMarketListings();
  const invalidate = useEconomyInvalidator();

  const coins = economy?.coins ?? 0;
  const [sellFragmentId, setSellFragmentId] = useState<string>("");
  const [sellPrice, setSellPrice] = useState<string>("");

  const ownedSellable = useMemo(
    () => FRAGMENTS.filter((f) => (inventory?.[f.id] || 0) >= 1),
    [inventory],
  );

  const listMutation = useMutation({
    mutationFn: async () => {
      const price = Number(sellPrice);
      return authedFetch("/api/market/list", { fragmentId: sellFragmentId, price });
    },
    onSuccess: () => {
      toast({ title: t("listingCreated") });
      setSellFragmentId("");
      setSellPrice("");
      invalidate();
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (listingId: string) => authedFetch("/api/market/cancel", { listingId }),
    onSuccess: () => {
      toast({ title: t("listingCanceled") });
      invalidate();
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const buyMutation = useMutation({
    mutationFn: async (listingId: string) => authedFetch("/api/market/buy", { listingId }),
    onSuccess: () => {
      toast({ title: t("purchaseSuccess") });
      invalidate();
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const myListings = (listings || []).filter((listing) => listing.isOwn);

  const parsedPrice = Number.parseInt(sellPrice, 10);
  const priceValid = Number.isInteger(parsedPrice) && parsedPrice >= MIN_LISTING_PRICE && parsedPrice <= MAX_LISTING_PRICE;
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
              {ownedSellable.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("nothingToSell")}</p>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">{t("selectFragment")}</label>
                      <Select value={sellFragmentId} onValueChange={setSellFragmentId}>
                        <SelectTrigger className="w-full rounded-xl"><SelectValue placeholder={t("selectFragment")} /></SelectTrigger>
                        <SelectContent className="glass-panel border-border/60">
                          {ownedSellable.map((fragment) => (
                            <SelectItem key={fragment.id} value={fragment.id}>
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
                        value={sellPrice}
                        onChange={(e) => setSellPrice(e.target.value)}
                        placeholder="25"
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
                    disabled={!sellFragmentId || !priceValid || listMutation.isPending}
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
                  const fragment = getFragment(listing.fragmentId);
                  return (
                    <div key={listing.id} className="flex items-center justify-between rounded-xl border border-border/50 bg-card/50 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">{fragment?.name || listing.fragmentId}</p>
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
