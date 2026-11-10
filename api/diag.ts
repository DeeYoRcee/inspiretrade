// Test: does lib/fragments import work?
import { FRAGMENTS } from "./lib/fragments";

export default function handler(_req: any, res: any) {
  res.status(200).json({ ok: true, fragmentsCount: FRAGMENTS.length });
}
