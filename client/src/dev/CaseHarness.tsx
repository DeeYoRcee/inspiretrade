/**
 * Dev-only case/theme harness (never shipped): mounts the REAL
 * CaseOpeningDialog preview (3D container + contains grid) and the Snow
 * backdrop so the visuals can be screenshot-verified without auth.
 * ?stage=preview|show&theme=snow|cr7
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CaseOpeningDialog } from "@/components/rewards/CaseOpeningDialog";
import { ThemeBackdrop } from "@/components/layout/ThemeBackdrop";
import { LanguageProvider } from "@/lib/language-context";
import { FRAGMENTS, CASES, type FragmentDef } from "@shared/fragments";
import "../index.css";

const qs = new URLSearchParams(location.search);
const theme = qs.get("theme") || "snow";
document.documentElement.dataset.theme = theme;

function CaseHarness() {
  const [open, setOpen] = useState(true);
  const stage = qs.get("stage") || "preview";
  const caseType = (qs.get("case") || "inspire") as "inspire";
  const black = stage === "showblack"
    ? { label: CASES[caseType].blackDrop.label, accountSize: CASES[caseType].blackDrop.accountSize, set: caseType }
    : null;
  const result: FragmentDef | null = stage === "show" ? FRAGMENTS[6] : null; // a covert piece
  return (
    <div className="flex min-h-[100dvh] items-center justify-center p-4">
      <ThemeBackdrop />
      <CaseOpeningDialog
        open={open}
        result={result}
        black={black}
        caseType={caseType}
        onClose={() => setOpen(false)}
        onConfirm={async () => (black ? { black } : { fragment: result })}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<LanguageProvider><CaseHarness /></LanguageProvider>);
