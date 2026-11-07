const PLANS = {
  monthly: { id: "plan_uAJSe5gvChYEy", price: 3.99, label: "Monthly", period: "/ mo" },
  yearly: { id: "plan_s3vO6JEWy2ruA", price: 24.99, label: "Yearly", period: "/ yr" },
  lifetime: { id: "plan_OloGrVT1gLT5y", price: 109.99, label: "Lifetime", period: "" },
};

export default function handler(_req: any, res: any) {
  return res.status(200).json(PLANS);
}
