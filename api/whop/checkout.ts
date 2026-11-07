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

  if (!plan) return res.status(400).json({ error: "Tarif noto‘g‘ri tanlangan." });
  if (typeof firebaseUid !== "string" || !firebaseUid || firebaseUid.length > 128) {
    return res.status(400).json({ error: "Avval akkauntingizga kiring." });
  }

  const apiKey = process.env.WHOP_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "Whop sozlanmagan. Sayt egasi Vercel sozlamalarini tekshirishi kerak." });
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
      return res.status(502).json({ error: "Whop checkout havolasi qaytmadi. Tarif va kompaniya ID sini tekshiring." });
    }

    return res.status(200).json({ checkoutUrl: checkout.purchase_url });
  } catch (error: any) {
    const status = error?.statusCode || error?.status;
    const rawMessage = typeof error?.message === "string" ? error.message : "";
    console.error("Whop checkout creation failed:", error);

    if (status === 401 || status === 403 || /forbidden|not authorized|permission/i.test(rawMessage)) {
      return res.status(502).json({
        error: "Whop API kalitida ruxsat yetarli emas. Whop'da checkout_configuration:create hamda plan:basic:read ruxsatlarini yoqing; Vercel'dagi WHOP_COMPANY_ID va API kalit bir xil akkauntniki ekanini tekshiring.",
      });
    }

    if (status === 404) {
      return res.status(502).json({
        error: "Whop kompaniya yoki tarif ID si topilmadi. WHOP_COMPANY_ID va tarif ID larini tekshiring.",
      });
    }

    return res.status(502).json({
      error: "Whop checkout yaratilmadi. Vercel Runtime Logs'dagi eng yangi xato ma'lumotini tekshiring.",
    });
  }
}
