export default function handler(_req: any, res: any) {
  res.status(200).json({ status: "ok", version: "consolidated-1", functions: 8, time: new Date().toISOString() });
}
