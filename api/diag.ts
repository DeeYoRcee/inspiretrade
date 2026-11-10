import { HELPER_LOADED } from "./firebase-helper";
import { FRAGMENTS } from "./fragments-helper";

export default function handler(_req: any, res: any) {
  res.status(200).json({ ok: true, helperLoaded: HELPER_LOADED, fragmentsCount: FRAGMENTS.length });
}
