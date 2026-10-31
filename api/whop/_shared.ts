import Whop from "@whop/sdk";

export const COMPANY_ID = process.env.WHOP_COMPANY_ID || "biz_lYc5Z0SFSvie4m";

export const PLANS = {
  monthly:  { id: "plan_uAJSe5gvChYEy", price: 3.99,   label: "Monthly",  period: "/ mo" },
  yearly:   { id: "plan_s3vO6JEWy2ruA", price: 24.99,  label: "Yearly",   period: "/ yr" },
  lifetime: { id: "plan_OloGrVT1gLT5y", price: 109.99, label: "Lifetime", period: "" },
};

export function getWhop() {
  const apiKey = process.env.WHOP_API_KEY;
  if (!apiKey) throw new Error("WHOP_API_KEY is not set");
  return new Whop({ apiKey });
}
