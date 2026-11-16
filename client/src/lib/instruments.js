export function normalizeInstrument(value, fallbackSymbol = "") {
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    const symbol = typeof record.symbol === "string"
        ? record.symbol.trim().toUpperCase()
        : fallbackSymbol.trim().toUpperCase();
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!symbol || !name)
        return null;
    return {
        symbol,
        name,
        category: record.category === "CRYPTO" ? "CRYPTO" : "FOREX",
        enabled: record.enabled !== false,
        sortOrder: typeof record.sortOrder === "number" ? record.sortOrder : Number.MAX_SAFE_INTEGER,
    };
}
export function parseInstrumentCatalog(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => normalizeInstrument(item))
            .filter((instrument) => instrument !== null);
    }
    if (!value || typeof value !== "object")
        return [];
    return Object.entries(value)
        .map(([symbol, item]) => normalizeInstrument(item, symbol))
        .filter((instrument) => instrument !== null);
}
export function sortInstrumentCatalog(instruments) {
    return instruments
        .filter((instrument) => instrument.enabled)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.symbol.localeCompare(b.symbol));
}
export function findInstrumentBySymbol(instruments, symbol) {
    return instruments.find((instrument) => instrument.symbol === symbol);
}
