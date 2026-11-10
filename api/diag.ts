// Test: import _firebase and _fragments together (like economy APIs do)
import { handle, requireUser, assertPost, rtdb, HttpError } from "./_firebase";
import { FRAGMENTS } from "./_fragments";

export default handle(async (req: any, res: any) => {
  assertPost(req);
  res.status(200).json({
    ok: true,
    fragmentsCount: FRAGMENTS.length,
    handleWorks: typeof handle === "function",
    requireUserWorks: typeof requireUser === "function",
    rtdbWorks: typeof rtdb === "function",
  });
});
