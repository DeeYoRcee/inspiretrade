import { COMPANY_ID, PLANS, getWhop } from "./_shared";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { planKey, firebaseUid } = req.body as {
    planKey?: string;
    firebaseUid?: string;
  };
  const plan = planKey ? (PLANS as Record<string, { id: string }>)[planKey] : undefined;

  if (!plan) return res.status(400).json({ error: "Invalid premium plan." });
  if (typeof firebaseUid !== "string" || !firebaseUid || firebaseUid.length > 128) {
    return res.status(400).json({ error: "Sign in before purchasing." });
  }
  if (!process.env.WHOP_API_KEY) {
    return res.status(503).json({ error: "Whop payments are not configured. Please contact the site owner." });
  }

  try {
    const whop = getWhop();
    const appUrl = process.env.APP_URL;
    const redirectUrl = appUrl?.startsWith("https://")
      ? `${appUrl.replace(/\/$/, "")}/?premium=success`
      : undefined;

    const checkout = await (whop as any).checkoutConfigurations.create({
      account_id: COMPANY_ID,
      variant_id: plan.id,
      mode: "payment",
      metadata: { firebaseUid },
      ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    });

    if (!checkout?.purchase_url) {
      throw new Error("Whop did not return a checkout URL");
    }

    return res.status(200).json({ checkoutUrl: checkout.purchase_url });
  } catch (error) {
    console.error("Whop checkout creation failed:", error);
    return res.status(502).json({
      error: "Checkout yaratilmadi. Vercel loglarida Whop API xatosini tekshiring.",
    });
  }
}
