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

async function loadInstrumentCatalog(): Promise<Instrument[]> {
  try {
    const snapshot = await get(ref(db, "instrumentCatalog"));
    if (snapshot.exists()) {
      const databaseInstruments = sortInstrumentCatalog(
        parseInstrumentCatalog(snapshot.val())
      );
      if (databaseInstruments.length > 0) return databaseInstruments;
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