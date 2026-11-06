import { PLANS } from "./_shared";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { planKey, firebaseUid } = req.body as { planKey: string; firebaseUid: string };
    const plan = (PLANS as any)[planKey];
    if (!plan) return res.status(400).json({ error: "Invalid plan" });
    if (typeof firebaseUid !== "string" || !firebaseUid || firebaseUid.length > 128) {
      return res.status(400).json({ error: "Sign in before purchasing." });
    }

    const apiKey = process.env.WHOP_API_KEY;

    // Without an API key we can't create a checkout configuration with metadata,
    // but Whop's hosted checkout page works without one.
    if (!apiKey) {
      return res.status(200).json({
        checkoutUrl: `https://whop.com/checkout/${plan.id}`,
      });
    }

    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const redirectUrl = host ? `https://${host}/?premium=success` : undefined;

    const { getWhop } = await import("./_shared");
    const whop = getWhop();
    const config = await (whop as any).checkoutConfigurations.create({
      plan_id: plan.id,
      metadata: { firebaseUid },
      ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    });
    res.status(200).json({ checkoutUrl: config.purchase_url || `https://whop.com/checkout/${plan.id}` });
  } catch (e) {
    console.error("Whop checkout error:", e);
    res.status(502).json({ error: "Unable to create a Whop checkout. Please try again." });
  }
}
