import { useEffect, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAddTrade } from "@/hooks/use-trades";
import { useInstruments } from "@/hooks/use-instruments";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CalendarIcon, Check, ChevronsUpDown, Plus } from "lucide-react";
import { format } from "date-fns";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language-context";
import { findInstrumentBySymbol } from "@/lib/instruments";

const formSchema = z.object({
  instrumentSymbol: z.string().min(1, "Instrument is required"),
  type: z.enum(["BUY", "SELL"]),
  category: z.enum(["FOREX", "CRYPTO"]).optional(),
  entryPrice: z.coerce.number().positive("Must be > 0"),
  exitPrice: z.coerce.number().positive("Must be > 0"),
  lotSize: z.coerce.number().positive("Must be > 0"),
  profitType: z.enum(["PROFIT", "LOSS"]),
  profitValue: z.coerce.number(),
  date: z.date(),
  emotion: z.enum(["happy", "neutral", "sad"]).optional(),
});

type FormValues = z.infer<typeof formSchema>;

const EMOTIONS: { value: "happy" | "neutral" | "sad"; emoji: string; label: string; color: string }[] = [
  { value: "happy", emoji: ":)", label: "Happy", color: "bg-success/20 border-success text-success" },
  { value: "neutral", emoji: ":|", label: "Neutral", color: "bg-yellow-500/20 border-yellow-500 text-yellow-500" },
  { value: "sad", emoji: ":(", label: "Sad", color: "bg-destructive/20 border-destructive text-destructive" },
];

interface AddTradeDialogProps {
  defaultDate?: Date;
  trigger?: ReactNode;
}

export function AddTradeDialog({ defaultDate, trigger }: AddTradeDialogProps) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [instrumentOpen, setInstrumentOpen] = useState(false);
  const { mutate: addTrade, isPending } = useAddTrade();
  const {
    data: instruments = [],
    isLoading: instrumentsLoading,
  } = useInstruments();
  const { toast } = useToast();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      instrumentSymbol: "",
      type: "BUY",
      category: undefined,
      entryPrice: 0,
      exitPrice: 0,
      lotSize: 0,
      profitType: "PROFIT",
      profitValue: 0,
      date: defaultDate || new Date(),
      emotion: undefined,
    },
  });

  const selectedEmotion = form.watch("emotion");
  const selectedCategory = form.watch("category");
  const categoryInstruments = selectedCategory
    ? instruments.filter((instrument) => instrument.category === selectedCategory)
    : [];
  const selectedInstrument = findInstrumentBySymbol(categoryInstruments, form.watch("instrumentSymbol"));

  useEffect(() => {
    if (open && defaultDate) {
      form.setValue("date", defaultDate);
    }
  }, [defaultDate, form, open]);

  useEffect(() => {
    const currentSymbol = form.getValues("instrumentSymbol");
    if (
      currentSymbol &&
      selectedCategory &&
      !categoryInstruments.some((instrument) => instrument.symbol === currentSymbol)
    ) {
      form.setValue("instrumentSymbol", "", {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
  }, [categoryInstruments, form, selectedCategory]);

  const onSubmit = (data: FormValues) => {
    if (!data.category) {
      form.setError("category", { message: t("categoryRequired") });
      return;
    }

    const instrument = findInstrumentBySymbol(
      instruments.filter((item) => item.category === data.category),
      data.instrumentSymbol,
    );
    if (!instrument) {
      form.setError("instrumentSymbol", { message: t("instrumentRequired") });
      return;
    }

    const profit = data.profitType === "PROFIT" ? Math.abs(data.profitValue) : -Math.abs(data.profitValue);
    addTrade({
      assetName: instrument.symbol,
      instrumentSymbol: instrument.symbol,
      instrumentName: instrument.name,
      type: data.type,
      category: data.category,
      entryPrice: data.entryPrice,
      exitPrice: data.exitPrice,
      lotSize: data.lotSize,
      profit,
      timestamp: data.date.getTime(),
      emotion: data.emotion,
    }, {
      onSuccess: () => {
        toast({ title: t("tradeLogged") });
        setOpen(false);
        form.reset();
      },
      onError: (error) => {
        toast({ title: t("error"), description: error.message, variant: "destructive" });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button className="font-semibold rounded-xl hover-glow gap-2">
            <Plus className="w-4 h-4" />
            {t("logNewTrade")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px] glass-panel border-border max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl font-display">{t("logTrade")}</DialogTitle>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 mt-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2 col-span-2">
              <Label>{t("tradeDate")}</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn("w-full justify-start text-left font-normal bg-background/50", !form.watch("date") && "text-muted-foreground")}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {form.watch("date") ? format(form.watch("date"), "PPP") : <span>{t("pickDate")}</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar
                    mode="single"
                    selected={form.watch("date")}
                    onSelect={(date) => date && form.setValue("date", date)}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2 col-span-2">
              <Label>{t("category")}</Label>
              <Select
                value={selectedCategory ?? ""}
                onValueChange={(value: "FOREX" | "CRYPTO") =>
                  form.setValue("category", value, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              >
                <SelectTrigger className="bg-background/50">
                  <SelectValue placeholder={t("selectCategory")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FOREX">FOREX</SelectItem>
                  <SelectItem value="CRYPTO">CRYPTO</SelectItem>
                </SelectContent>
              </Select>
              {form.formState.errors.category && (
                <p className="text-xs text-destructive">{t("categoryRequired")}</p>
              )}
            </div>

            <div className="space-y-2 col-span-2">
              <Label>{t("instrument")}</Label>
              <Popover open={instrumentOpen} onOpenChange={setInstrumentOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={instrumentOpen}
                    disabled={instrumentsLoading || !selectedCategory}
                    className="w-full justify-between bg-background/50 font-normal"
                  >
                    {instrumentsLoading ? (
                      <span className="text-muted-foreground">{t("loadingInstruments")}</span>
                    ) : !selectedCategory ? (
                      <span className="text-muted-foreground">{t("selectCategoryFirst")}</span>
                    ) : selectedInstrument ? (
                      <span className="flex min-w-0 items-center gap-2 text-left">
                        <span className="font-semibold">{selectedInstrument.symbol}</span>
                        <span className="truncate text-muted-foreground">{selectedInstrument.name}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t("selectInstrument")}</span>
                    )}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[calc(100vw-3rem)] p-0 sm:w-[380px]" align="start">
                  <Command>
                    <CommandInput placeholder={t("searchInstrument")} />
                    <CommandList>
                      {instrumentsLoading ? (
                        <div className="py-6 text-center text-sm text-muted-foreground">
                          {t("loadingInstruments")}
                        </div>
                      ) : (
                        <>
                          <CommandEmpty>{t("instrumentNotFound")}</CommandEmpty>
                          {categoryInstruments.map((instrument) => (
                            <CommandItem
                              key={instrument.symbol}
                              value={`${instrument.symbol} ${instrument.name}`}
                              onSelect={() => {
                                form.setValue("instrumentSymbol", instrument.symbol, {
                                  shouldDirty: true,
                                  shouldValidate: true,
                                });
                                form.setValue("category", instrument.category, {
                                  shouldDirty: true,
                                  shouldValidate: true,
                                });
                                setInstrumentOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  selectedInstrument?.symbol === instrument.symbol
                                    ? "opacity-100"
                                    : "opacity-0"
                                )}
                              />
                              <span className="font-semibold">{instrument.symbol}</span>
                              <span className="truncate text-muted-foreground">{instrument.name}</span>
                            </CommandItem>
                          ))}
                        </>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {form.formState.errors.instrumentSymbol && (
                <p className="text-xs text-destructive">{t("instrumentRequired")}</p>
              )}
            </div>

            <div className="space-y-2 col-span-2 sm:col-span-1">
              <Label>{t("positionType")}</Label>
              <Select defaultValue="BUY" onValueChange={(val: "BUY" | "SELL") => form.setValue("type", val)}>
                <SelectTrigger className="bg-background/50"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="BUY" className="text-success font-medium">BUY</SelectItem>
                  <SelectItem value="SELL" className="text-destructive font-medium">SELL</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 col-span-2 sm:col-span-1">
              <Label>{t("lotSize")}</Label>
              <Input type="number" step="any" {...form.register("lotSize")} className="bg-background/50 font-number" />
            </div>

            <div className="space-y-2 col-span-2 sm:col-span-1">
              <Label>{t("entryPrice")}</Label>
              <Input type="number" step="any" {...form.register("entryPrice")} className="bg-background/50 font-number" />
            </div>

            <div className="space-y-2 col-span-2 sm:col-span-1">
              <Label>{t("exitPrice")}</Label>
              <Input type="number" step="any" {...form.register("exitPrice")} className="bg-background/50 font-number" />
            </div>

            <div className="space-y-2 col-span-2">
              <Label>{t("profitLoss")}</Label>
              <div className="flex gap-2">
                <Select defaultValue="PROFIT" onValueChange={(val: "PROFIT" | "LOSS") => form.setValue("profitType", val as any)}>
                  <SelectTrigger className="w-[120px] bg-background/50"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PROFIT" className="text-success font-medium">PROFIT</SelectItem>
                    <SelectItem value="LOSS" className="text-destructive font-medium">LOSS</SelectItem>
                  </SelectContent>
                </Select>
                 <Input type="number" step="any" {...form.register("profitValue")} className="bg-background/50 font-number flex-1" placeholder={t("enterAmount")} />
              </div>
            </div>

            <div className="space-y-2 col-span-2">
              <Label>{t("howFeel")}</Label>
              <div className="flex gap-2">
                {EMOTIONS.map(e => (
                  <button
                    key={e.value}
                    type="button"
                    onClick={() => form.setValue("emotion", selectedEmotion === e.value ? undefined : e.value)}
                    className={cn(
                      "flex-1 py-2 rounded-xl border-2 font-mono text-lg font-bold transition-all",
                      selectedEmotion === e.value
                        ? e.color
                        : "border-border/40 bg-background/50 text-muted-foreground hover:border-border"
                    )}
                  >
                    {e.emoji}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="pt-2">
            <Button
              type="submit"
              disabled={isPending || instrumentsLoading || instruments.length === 0}
              className="w-full hover-glow"
            >
              {isPending ? t("saving") : t("saveTrade")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
