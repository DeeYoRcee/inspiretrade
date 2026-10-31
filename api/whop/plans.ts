import { PLANS } from "./_shared";

export default function handler(_req: any, res: any) {
  res.status(200).json(PLANS);
}
