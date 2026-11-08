import { useQuery } from "@tanstack/react-query";
import { get, ref } from "firebase/database";
import seedCatalog from "@/data/instrument-catalog.seed.json";
import { db } from "@/lib/firebase";
import {
  parseInstrumentCatalog,
  sortInstrumentCatalog,
  type Instrument,
} from "@/lib/instruments";

const seedInstruments = sortInstrumentCatalog(parseInstrumentCatalog(seedCatalog));
const nasdaqSeed = seedInstruments.find((instrument) => instrument.symbol === "NAS100");

async function loadInstrumentCatalog(): Promise<Instrument[]> {
  try {
    const snapshot = await get(ref(db, "instrumentCatalog"));
    if (snapshot.exists()) {
      const databaseCatalog = parseInstrumentCatalog(snapshot.val());
      if (databaseCatalog.length > 0) {
        // Keep the NASDAQ index available even when Firebase has a custom catalog.
        const mergedCatalog = nasdaqSeed && !databaseCatalog.some((item) => item.symbol === nasdaqSeed.symbol)
          ? [...databaseCatalog, nasdaqSeed]
          : databaseCatalog;
        return sortInstrumentCatalog(mergedCatalog);
      }
    }
  } catch (error) {
    console.warn("Instrument catalog database read failed; using seed catalog.", error);
  }

  return seedInstruments;
}

export function useInstruments() {
  return useQuery({
    queryKey: ["instrumentCatalog"],
    queryFn: loadInstrumentCatalog,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}
