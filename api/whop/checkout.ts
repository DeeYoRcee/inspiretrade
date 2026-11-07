import Whop from "@whop/sdk";

const COMPANY_ID = process.env.WHOP_COMPANY_ID || "biz_lYc5Z0SFSvie4m";
const PLANS = {
  monthly: { id: "plan_uAJSe5gvChYEy", price: 3.99, label: "Monthly", period: "/ mo" },
  yearly: { id: "plan_s3vO6JEWy2ruA", price: 24.99, label: "Yearly", period: "/ yr" },
  lifetime: { id: "plan_OloGrVT1gLT5y", price: 109.99, label: "Lifetime", period: "" },
};

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

  const apiKey = process.env.WHOP_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "Whop payments are not configured. Please contact the site owner." });
  }

  try {
    const whop = new Whop({ apiKey });
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
      console.error("Whop checkout response did not contain purchase_url");
      return res.status(502).json({ error: "Whop did not return a checkout link. Check the plan and account in Whop." });
    }

    return res.status(200).json({ checkoutUrl: checkout.purchase_url });
  } catch (error) {
    console.error("Whop checkout creation failed:", error);
    return res.status(502).json({
      error: "Checkout yaratilmadi. Vercel Runtime Logs'da Whop API xatosini tekshiring.",
    });
  }
}
