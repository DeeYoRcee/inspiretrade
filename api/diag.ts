// Test: does _lib/_test trivial import work?
import { TEST_CONST } from "./_lib/_test";

export default function handler(_req: any, res: any) {
  res.status(200).json({ ok: true, test: TEST_CONST });
}
