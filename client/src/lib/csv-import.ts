/**
 * Phase 57 — CSV import for external broker trades.
 *
 * Pure parser/validator (no Firebase, no React): accepts common trade-history
 * exports (MT5 Report "Time/Type/Volume/Price/Profit", cTrader, generic
 * CSV/TSV), auto-maps columns with sensible aliases, validates every row and
 * flags duplicates — nothing is silently imported. The actual compatibility
 * claims stay modest: the mapping UI lets the user point columns explicitly
 * when auto-detection fails.
 */
import type { TradeSource } from "./trade-source";

export interface CsvParseResult {
  headers: string[];
  rows: { line: number; cells: string[] }[];
  delimiter: string;
}

/** Delimiter detection from the header line: tab > semicolon > comma. */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts: [string, number][] = [
    ["\t", (firstLine.match(/\t/g) || []).length],
    [";", (firstLine.match(/;/g) || []).length],
    [",", (firstLine.match(/,/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/** RFC-4180-ish quoted-field-aware CSV splitter. */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

export function parseTradesCsv(text: string): CsvParseResult {
  const delimiter = detectDelimiter(text);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [], delimiter };
  const headers = splitCsvLine(lines[0], delimiter).map((h) => h.replace(/^\ufeff/, "").trim());
  const rows: CsvParseResult["rows"] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delimiter);
    rows.push({ line: i + 1, cells });
  }
  return { headers, rows, delimiter };
}

// ---- column mapping -------------------------------------------------------

export type CsvField = "symbol" | "type" | "volume" | "entry" | "exit" | "openTime" | "closeTime" | "profit" | "sl" | "tp";

export type ColumnMapping = Partial<Record<CsvField, string>>;

/** header → canonical field aliases (case-insensitive, substring match) */
const ALIASES: Record<CsvField, string[]> = {
  symbol: ["symbol", "item", "instrument", "pair", "asset", "ticker"],
  type: ["type", "direction", "side", "action", "buy/sell"],
  volume: ["volume", "lots", "lot", "size", "qty", "quantity", "amount(lots)"],
  entry: ["open price", "entry price", "entry", "price", "open"],
  exit: ["close price", "exit price", "exit", "close"],
  openTime: ["open time", "time", "date", "opened", "entry time"],
  closeTime: ["close time", "closed", "exit time", "closing time"],
  profit: ["profit", "p/l", "pnl", "gain", "net profit", "profit/loss"],
  sl: ["s/l", "sl", "stop loss", "stoploss", "stop"],
  tp: ["t/p", "tp", "take profit", "takeprofit", "target"],
};

export function autoMapColumns(headers: string[]): ColumnMapping {
  const lower = headers.map((h) => h.toLowerCase().trim());
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  for (const field of Object.keys(ALIASES) as CsvField[]) {
    for (const alias of ALIASES[field]) {
      // exact match first, then prefix/substring for verbose exports
      let idx = lower.findIndex((h, i) => !used.has(headers[i]) && h === alias);
      if (idx === -1) idx = lower.findIndex((h, i) => !used.has(headers[i]) && h.startsWith(alias));
      if (idx === -1) continue;
      mapping[field] = headers[idx];
      used.add(headers[idx]);
      break;
    }
  }
  // "time" alias would steal closeTime from MT5 two-column exports — keep the
  // FIRST time column as openTime and a distinctly named one as closeTime
  if (mapping.openTime === mapping.closeTime) delete mapping.closeTime;
  return mapping;
}

// ---- value parsing ---------------------------------------------------------

export function parseNum(v: string | undefined): number | null {
  if (v === undefined) return null;
  const cleaned = v.replace(/\s|,(?=\d{3}\b)/g, "").replace(/[$€£]/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Accepts ISO, "2024.01.15 10:30", "2024-01-15 10:30:00", "01/15/2024",
 *  "15/01/2024" (day-first when unambiguous), and epoch sec/ms. */
export function parseTimestamp(v: string | undefined): number | null {
  if (!v) return null;
  const s = v.trim();
  if (!s) return null;
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  const normalized = s.replace(/\./g, "-").replace("T", " ");
  const dmy = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{4})([ T].*)?$/);
  const mdy = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)?$/);
  let parsed: Date | null = null;
  if (dmy) parsed = new Date(`${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}${(dmy[4] || " 00:00").replace(" ", "T")}`);
  else if (mdy) {
    const a = Number(mdy[1]);
    const b = Number(mdy[2]);
    // month-first (US) when the first number is a plausible month; when the
    // first number cannot be a month (>12) it must be the day (day-first EU)
    parsed = a > 12
      ? new Date(`${mdy[3]}-${mdy[2].padStart(2, "0")}-${mdy[1].padStart(2, "0")}${(mdy[4] || " 00:00").replace(" ", "T")}`)
      : new Date(`${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}${(mdy[4] || " 00:00").replace(" ", "T")}`);
  } else {
    parsed = new Date(normalized.replace(" ", "T"));
    if (isNaN(parsed.getTime())) parsed = new Date(s);
  }
  return parsed && !isNaN(parsed.getTime()) ? parsed.getTime() : null;
}

export function parseDirection(v: string | undefined): "BUY" | "SELL" | null {
  if (!v) return null;
  const s = v.toLowerCase().trim();
  if (/^(buy|b|long|0)$/.test(s)) return "BUY";
  if (/^(sell|s|short|1)$/.test(s)) return "SELL";
  if (s.includes("buy") || s.includes("long")) return "BUY";
  if (s.includes("sell") || s.includes("short")) return "SELL";
  return null;
}

export interface InstrumentResolution { symbol: string; name: string; category: "FOREX" | "CRYPTO" }

/** Map a raw CSV symbol onto the platform catalog when possible; unknown
 *  symbols keep their raw name (external brokers trade more than we list). */
export function resolveInstrument(
  rawSymbol: string,
  findInstrument?: (symbol: string) => { symbol: string; name: string; category: string } | undefined,
): InstrumentResolution {
  const raw = rawSymbol.trim().toUpperCase();
  const candidates = [raw, raw.replace(/^(XAU|XAG)/, "$1USD"), raw.replace(/USDT?$/, "USD"), raw + "USD"];
  for (const c of candidates) {
    const hit = findInstrument?.(c);
    if (hit) return { symbol: hit.symbol, name: hit.name, category: hit.category === "crypto" ? "CRYPTO" : "FOREX" };
  }
  return { symbol: raw, name: raw, category: /BTC|ETH|SOL|XRP|USDT|COIN/.test(raw) ? "CRYPTO" : "FOREX" };
}

// ---- row validation --------------------------------------------------------

export interface MappedTrade {
  line: number;
  instrumentSymbol: string;
  instrumentName: string;
  category: "FOREX" | "CRYPTO";
  type: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number;
  lotSize: number;
  profit: number;
  timestamp: number;
  exitTime?: number;
  slPrice?: number | null;
  tpPrice?: number | null;
}

export interface InvalidRow { line: number; reason: string }
export interface DuplicateRow { line: number; reason: string }

export interface CsvValidation {
  valid: MappedTrade[];
  invalid: InvalidRow[];
  duplicates: DuplicateRow[];
}

const REQUIRED: CsvField[] = ["symbol", "type", "volume", "entry", "exit", "openTime", "profit"];

/** CSV-internal duplicate check: symbol + direction + entry/exit + ±2 min time. */
function sameMappedTrade(a: MappedTrade, b: MappedTrade): boolean {
  return (
    a.instrumentSymbol.toUpperCase() === b.instrumentSymbol.toUpperCase() &&
    a.type === b.type &&
    Math.abs(a.entryPrice - b.entryPrice) < Math.max(1e-6, a.entryPrice * 1e-6) &&
    Math.abs(a.exitPrice - b.exitPrice) < Math.max(1e-6, a.exitPrice * 1e-6) &&
    Math.abs(a.timestamp - b.timestamp) <= 2 * 60 * 1000
  );
}

function sameJournalTrade(a: MappedTrade, b: { assetName: string; type: string; entryPrice: number; exitPrice: number; timestamp: number }): boolean {
  return (
    a.instrumentSymbol.toUpperCase() === b.assetName.toUpperCase() &&
    a.type === b.type &&
    Math.abs(a.entryPrice - b.entryPrice) < Math.max(1e-6, a.entryPrice * 1e-6) &&
    Math.abs(a.exitPrice - b.exitPrice) < Math.max(1e-6, a.exitPrice * 1e-6) &&
    Math.abs(a.timestamp - b.timestamp) <= 2 * 60 * 1000
  );
}

export function validateCsvRows(
  parsed: CsvParseResult,
  mapping: ColumnMapping,
  opts: {
    /** existing journal trades for duplicate detection */
    existingTrades?: { assetName: string; type: string; entryPrice: number; exitPrice: number; timestamp: number }[];
    findInstrument?: (symbol: string) => { symbol: string; name: string; category: string } | undefined;
  } = {},
): CsvValidation {
  const valid: MappedTrade[] = [];
  const invalid: InvalidRow[] = [];
  const duplicates: DuplicateRow[] = [];

  for (const missing of REQUIRED) if (!mapping[missing]) {
    return { valid, invalid: [{ line: 0, reason: `column mapping missing: ${missing}` }], duplicates };
  }

  const cell = (row: CsvParseResult["rows"][number], field: CsvField): string | undefined => {
    const header = mapping[field];
    if (!header) return undefined;
    const idx = parsed.headers.indexOf(header);
    return idx >= 0 ? row.cells[idx] : undefined;
  };

  for (const row of parsed.rows) {
    const symbolRaw = cell(row, "symbol");
    const direction = parseDirection(cell(row, "type"));
    const volume = parseNum(cell(row, "volume"));
    const entry = parseNum(cell(row, "entry"));
    const exit = parseNum(cell(row, "exit"));
    const openTime = parseTimestamp(cell(row, "openTime"));
    const profit = parseNum(cell(row, "profit"));

    if (!symbolRaw) { invalid.push({ line: row.line, reason: "missing symbol" }); continue; }
    if (!direction) { invalid.push({ line: row.line, reason: `unreadable direction "${cell(row, "type") ?? ""}"` }); continue; }
    if (volume === null || volume <= 0) { invalid.push({ line: row.line, reason: `invalid volume "${cell(row, "volume") ?? ""}"` }); continue; }
    if (entry === null || entry <= 0) { invalid.push({ line: row.line, reason: `invalid entry price "${cell(row, "entry") ?? ""}"` }); continue; }
    if (exit === null || exit <= 0) { invalid.push({ line: row.line, reason: `invalid exit price "${cell(row, "exit") ?? ""}"` }); continue; }
    if (openTime === null) { invalid.push({ line: row.line, reason: `unreadable date "${cell(row, "openTime") ?? ""}"` }); continue; }
    if (profit === null) { invalid.push({ line: row.line, reason: `missing profit/loss value` }); continue; }

    const closeTimeRaw = parseTimestamp(cell(row, "closeTime"));
    const inst = resolveInstrument(symbolRaw, opts.findInstrument);
    const trade: MappedTrade = {
      line: row.line,
      instrumentSymbol: inst.symbol,
      instrumentName: inst.name,
      category: inst.category,
      type: direction,
      entryPrice: entry,
      exitPrice: exit,
      lotSize: volume,
      profit,
      timestamp: openTime,
      exitTime: closeTimeRaw ?? undefined,
      slPrice: parseNum(cell(row, "sl")),
      tpPrice: parseNum(cell(row, "tp")),
    };

    // duplicates: inside the file, and against the existing journal
    const fileDup = valid.find((v) => sameMappedTrade(v, trade));
    if (fileDup) {
      duplicates.push({ line: row.line, reason: `duplicate of row ${fileDup.line}` });
      continue;
    }
    const existingHit = opts.existingTrades?.find((t) => sameJournalTrade(trade, t));
    if (existingHit) {
      duplicates.push({ line: row.line, reason: `already in journal (${existingHit.assetName} @ ${existingHit.entryPrice})` });
      continue;
    }
    valid.push(trade);
  }
  return { valid, invalid, duplicates };
}

export interface ImportableTrade {
  assetName: string;
  instrumentSymbol: string;
  instrumentName: string;
  type: "BUY" | "SELL";
  category: "FOREX" | "CRYPTO";
  entryPrice: number;
  exitPrice: number;
  lotSize: number;
  profit: number;
  timestamp: number;
  exitTime?: number;
  slPrice?: number | null;
  tpPrice?: number | null;
  source: TradeSource;
  brokerName?: string;
}

export function toImportableTrades(valid: MappedTrade[], brokerName: string): ImportableTrade[] {
  return valid.map((v) => ({
    assetName: v.instrumentSymbol,
    instrumentSymbol: v.instrumentSymbol,
    instrumentName: v.instrumentName,
    type: v.type,
    category: v.category,
    entryPrice: v.entryPrice,
    exitPrice: v.exitPrice,
    lotSize: v.lotSize,
    profit: v.profit,
    timestamp: v.timestamp,
    ...(v.exitTime !== undefined ? { exitTime: v.exitTime } : {}),
    ...(v.slPrice != null ? { slPrice: v.slPrice } : {}),
    ...(v.tpPrice != null ? { tpPrice: v.tpPrice } : {}),
    source: "external" as const,
    ...(brokerName ? { brokerName } : {}),
  }));
}
