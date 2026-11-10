export default function handler(_req: any, res: any) {
  res.status(200).json({ status: "ok", version: "cjs-fix-2", time: new Date().toISOString() });
}
