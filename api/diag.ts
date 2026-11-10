// Test: only firebase-admin (was working earlier)
import * as adminNamespace from "firebase-admin";
const admin: any = (adminNamespace as any).default ?? adminNamespace;

export default function handler(_req: any, res: any) {
  res.status(200).json({
    ok: true,
    adminHasAuth: typeof admin.auth,
    adminHasDatabase: typeof admin.database,
  });
}
