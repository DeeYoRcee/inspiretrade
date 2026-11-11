export default function handler(_req: any, res: any) {
  res.status(200).json({ status: "ok", version: "features-1", time: new Date().toISOString() });
}
