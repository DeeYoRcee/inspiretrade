import { COMPANY_ID, getWhop } from "./_shared";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ isPremium: false });
  try {
    const { firebaseUid } = req.body as { firebaseUid: string };
    if (!firebaseUid) return res.status(400).json({ isPremium: false });

    const whop = getWhop();
    const memberships = await (whop as any).memberships
      .list({
        company_id: COMPANY_ID,
        product_id: "prod_cUlL0SOCTM3S7",
        valid: true,
        metadata: JSON.stringify({ firebaseUid }),
      })
      .catch(() => ({ data: [] }));

    const isPremium = Array.isArray(memberships?.data) && memberships.data.length > 0;
    res.status(200).json({ isPremium });
  } catch {
    res.status(200).json({ isPremium: false });
  }
}
