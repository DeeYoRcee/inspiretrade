import Whop from "@whop/sdk";

const COMPANY_ID = process.env.WHOP_COMPANY_ID || "biz_lYc5Z0SFSvie4m";
const PREMIUM_PRODUCT_ID = "prod_cUlL0SOCTM3S7";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ isPremium: false });
  }

  const { firebaseUid } = req.body as { firebaseUid?: string };
  if (typeof firebaseUid !== "string" || !firebaseUid || firebaseUid.length > 128) {
    return res.status(400).json({ isPremium: false });
  }

  const apiKey = process.env.WHOP_API_KEY;
  if (!apiKey) return res.status(200).json({ isPremium: false });

  try {
    const whop = new Whop({ apiKey });
    const memberships = await (whop as any).memberships.list({
      company_id: COMPANY_ID,
      product_id: PREMIUM_PRODUCT_ID,
      valid: true,
      metadata: JSON.stringify({ firebaseUid }),
    });
    const isPremium = Array.isArray(memberships?.data) && memberships.data.length > 0;
    return res.status(200).json({ isPremium });
  } catch (error) {
    console.error("Whop membership verification failed:", error);
    return res.status(502).json({ isPremium: false, error: "Could not verify Whop membership." });
  }
}
