// Test: does importing shared/fragments (without using it) cause a crash?
import * as adminNamespace from "firebase-admin";
const admin: any = (adminNamespace as any).default ?? adminNamespace;
import { FRAGMENTS } from "../shared/fragments";

export default function handler(_req: any, res: any) {
  res.status(200).json({
    adminHasAuth: typeof admin.auth,
    fragmentsCount: FRAGMENTS.length,
  });
}
