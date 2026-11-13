/**
 * Shared grouped instrument options for every symbol <select> in the app —
 * TradingView-style <optgroup> sections (Indices / Metals / Forex / Crypto)
 * built from the canonical INSTRUMENTS catalog.
 */
import { INSTRUMENTS, type AssetClass } from "@shared/terminal";

const GROUPS: { label: string; cls: AssetClass }[] = [
  { label: "Indices", cls: "index" },
  { label: "Metals", cls: "metal" },
  { label: "Forex", cls: "forex" },
  { label: "Crypto", cls: "crypto" },
];

export function GroupedOptions({ withName = false }: { withName?: boolean }) {
  return (
    <>
      {GROUPS.map((g) => (
        <optgroup key={g.cls} label={g.label}>
          {INSTRUMENTS.filter((i) => i.assetClass === g.cls).map((i) => (
            <option key={i.symbol} value={i.symbol}>
              {withName ? `${i.symbol} · ${i.name}` : i.symbol}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
