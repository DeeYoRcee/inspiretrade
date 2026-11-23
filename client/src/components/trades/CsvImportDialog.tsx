/**
 * Phase 57 — CSV import workflow for external broker trades.
 * File select → parse → auto column mapping (editable) → preview with
 * valid / invalid / duplicate rows → confirm import. Nothing is saved until
 * the user confirms; invalid rows are never imported.
 */
import { useMemo, useRef, useState } from "react";
import { useAddTrade, type InsertTrade } from "@/hooks/use-trades";
import { useInstruments } from "@/hooks/use-instruments";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { FileWarning, FileUp, Loader2, Upload } from "lucide-react";
import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";
import { findInstrumentBySymbol } from "@/lib/instruments";
import {
  autoMapColumns, parseTradesCsv, toImportableTrades, validateCsvRows,
  type ColumnMapping, type CsvField, type CsvParseResult, type CsvValidation,
} from "@/lib/csv-import";

const FIELDS: { field: CsvField; label: string; required: boolean }[] = [
  { field: "symbol", label: "Symbol", required: true },
  { field: "type", label: "Direction (BUY/SELL)", required: true },
  { field: "volume", label: "Volume / lots", required: true },
  { field: "entry", label: "Entry price", required: true },
  { field: "exit", label: "Exit price", required: true },
  { field: "openTime", label: "Open date/time", required: true },
  { field: "profit", label: "Profit / loss", required: true },
  { field: "closeTime", label: "Close date/time", required: false },
  { field: "sl", label: "Stop loss", required: false },
  { field: "tp", label: "Take profit", required: false },
];

export function CsvImportDialog({
  open, onOpenChange, existingTrades,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  existingTrades: { assetName: string; type: string; entryPrice: number; exitPrice: number; timestamp: number }[];
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { mutateAsync: addTrade, isPending } = useAddTrade();
  const { data: instruments = [] } = useInstruments();
  const fileRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<CsvParseResult | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [brokerName, setBrokerName] = useState("");
  const [imported, setImported] = useState(0);

  const reset = () => {
    setFileName("");
    setParsed(null);
    setMapping({});
    setImported(0);
  };

  const onFilePicked = async (file?: File | null) => {
    if (!file) return;
    const text = await file.text();
    const result = parseTradesCsv(text);
    if (!result.rows.length) {
      toast({ title: t("error"), description: "No data rows found in the file", variant: "destructive" });
      return;
    }
    setFileName(file.name);
    setParsed(result);
    setMapping(autoMapColumns(result.headers));
    setImported(0);
  };

  const findInstrument = useMemo(
    () => (symbol: string) => findInstrumentBySymbol(instruments, symbol),
    [instruments],
  );

  const validation: CsvValidation | null = useMemo(() => {
    if (!parsed) return null;
    return validateCsvRows(parsed, mapping, { existingTrades, findInstrument });
  }, [parsed, mapping, existingTrades, findInstrument]);

  const missingRequired = FIELDS.filter((f) => f.required && !mapping[f.field]);

  const doImport = async () => {
    if (!validation?.valid.length) return;
    const importable = toImportableTrades(validation.valid, brokerName.trim());
    let ok = 0;
    for (const trade of importable) {
      try {
        await addTrade(trade as InsertTrade);
        ok += 1;
      } catch { /* keep importing; the failed count is surfaced below */ }
    }
    setImported(ok);
    toast({
      title: ok === importable.length ? t("tradeLogged") : t("publicProfileSaveFailed"),
      description: `${ok}/${importable.length} imported`,
      variant: ok === importable.length ? "default" : "destructive",
    });
    if (ok === importable.length) reset();
  };

  const cellValue = (line: number, header: string | undefined) => {
    if (!parsed || !header) return "";
    const row = parsed.rows.find((r) => r.line === line);
    const idx = parsed.headers.indexOf(header);
    return row && idx >= 0 ? row.cells[idx] : "";
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="sm:max-w-2xl glass-panel border-border max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl font-display">Import broker CSV</DialogTitle>
        </DialogHeader>

        {!parsed ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Import trades from an external broker export (MT5, cTrader or any CSV/TSV with
              symbol, direction, volume, entry, exit, time and profit columns). Rows are
              validated and previewed before saving — nothing is imported silently.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt"
              className="hidden"
              onChange={(e) => void onFilePicked(e.target.files?.[0])}
            />
            <Button className="w-full gap-2" onClick={() => fileRef.current?.click()}>
              <FileUp className="h-4 w-4" /> Choose CSV file
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span className="truncate">📄 {fileName} — {parsed.rows.length} rows</span>
              <Button variant="ghost" size="sm" onClick={() => { reset(); fileRef.current?.click(); }}>
                <Upload className="h-3.5 w-3.5" /> Another file
              </Button>
            </div>

            {/* broker name for provenance */}
            <div className="space-y-1">
              <Label>Broker name</Label>
              <Input
                value={brokerName}
                onChange={(e) => setBrokerName(e.target.value)}
                placeholder="e.g. IC Markets, MT5 Demo…"
                maxLength={60}
                className="bg-background/50"
              />
            </div>

            {/* column mapping */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {FIELDS.map((f) => (
                <div key={f.field} className="space-y-1">
                  <Label className="text-[11px]">{f.label}{f.required && <span className="text-destructive"> *</span>}</Label>
                  <Select
                    value={mapping[f.field] ?? ""}
                    onValueChange={(v) => setMapping((m) => ({ ...m, [f.field]: v || undefined }))}
                  >
                    <SelectTrigger className={cn("h-8 bg-background/50 text-xs", f.required && !mapping[f.field] && "border-destructive/60")}>
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      {parsed.headers.map((h) => (
                        <SelectItem key={h} value={h} className="text-xs">{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            {validation && (
              <div className="flex flex-wrap gap-3 text-xs font-semibold">
                <span className="text-emerald-400">{validation.valid.length} valid</span>
                <span className="text-destructive">{validation.invalid.length} invalid</span>
                <span className="text-amber-400">{validation.duplicates.length} duplicates</span>
              </div>
            )}

            {/* preview list */}
            <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-xl border border-border/60 p-2">
              {validation?.valid.slice(0, 25).map((v) => (
                <div key={`v${v.line}`} className="flex items-center justify-between gap-2 rounded-lg bg-emerald-400/[0.07] px-2.5 py-1.5 text-xs">
                  <span className="truncate">
                    <span className="font-semibold">{v.instrumentSymbol}</span> · {v.type} · {v.lotSize} lots
                    · {v.entryPrice} → {v.exitPrice}
                  </span>
                  <span className={cn("font-number font-bold", v.profit >= 0 ? "text-emerald-400" : "text-destructive")}>
                    {v.profit >= 0 ? "+" : ""}${v.profit.toFixed(2)}
                  </span>
                </div>
              ))}
              {validation?.duplicates.slice(0, 15).map((d) => (
                <div key={`d${d.line}`} className="flex items-center gap-2 rounded-lg bg-amber-400/[0.07] px-2.5 py-1.5 text-xs text-amber-300">
                  <span className="font-semibold">row {d.line}</span> <span className="truncate">{d.reason} — skipped</span>
                </div>
              ))}
              {validation?.invalid.slice(0, 15).map((iv) => (
                <div key={`i${iv.line}`} className="flex items-center gap-2 rounded-lg bg-destructive/[0.08] px-2.5 py-1.5 text-xs text-destructive">
                  <FileWarning className="h-3.5 w-3.5 shrink-0" />
                  <span className="font-semibold">row {iv.line}</span> <span className="truncate">{iv.reason} — not importable</span>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => reset()}>{t("cancel")}</Button>
              <Button
                className="flex-1"
                disabled={isPending || missingRequired.length > 0 || !validation?.valid.length || imported > 0}
                onClick={() => void doImport()}
              >
                {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Import {validation?.valid.length ?? 0} trades
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
