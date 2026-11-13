/**
 * In-app news reader (TradingView style): the full story opens right here on
 * the site instead of bouncing to an external page. Shows the (server-side
 * translated) title + full summary, lets the user switch back to the original
 * English title, and keeps a secondary link to the source site.
 */
import { useState } from "react";
import { Globe2, Clock3, ExternalLink, Languages, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SYMBOL_COLOR, type NewsItem } from "@/lib/news-api";
import { useLanguage } from "@/lib/language-context";

export function ArticleDialog({ item, onClose }: { item: NewsItem | null; onClose: () => void }) {
  const { language } = useLanguage();
  const [showOriginal, setShowOriginal] = useState(false);
  if (!item) return null;

  const translated = language !== "en" && !!item.titleEn;

  return (
    <Dialog open={!!item} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto glass-panel border-border/60 sm:max-w-xl">
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-semibold text-foreground/80">
            <Globe2 className="h-3.5 w-3.5" />
            {item.source}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock3 className="h-3.5 w-3.5" />
            {new Date(item.publishedAt).toLocaleString()}
          </span>
          {item.symbols.slice(0, 4).map((sym) => (
            <span
              key={sym}
              className="rounded-full px-1.5 py-0.5 text-[10px] font-bold"
              style={{ color: SYMBOL_COLOR[sym] ?? "#9ca3af", backgroundColor: `${SYMBOL_COLOR[sym] ?? "#9ca3af"}1f` }}
            >
              {sym}
            </span>
          ))}
        </div>

        <DialogTitle className="text-lg font-bold leading-snug">
          {showOriginal && item.titleEn ? item.titleEn : item.title}
        </DialogTitle>

        {translated && (
          <div className="mt-1.5 flex items-center gap-2">
            <Badge variant="outline" className="rounded-full text-[10px] gap-1 border-sky-500/40 text-sky-400">
              <Languages className="h-3 w-3" />
              {language.toUpperCase()}
            </Badge>
            <button
              onClick={() => setShowOriginal((v) => !v)}
              className="text-[11px] font-semibold text-sky-400 underline-offset-2 hover:underline"
            >
              {showOriginal ? "Show translation" : "Show original (English)"}
            </button>
          </div>
        )}

        <div className="mt-3 whitespace-pre-line text-sm leading-relaxed text-foreground/90">
          {item.summary || "—"}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="rounded-full gap-1.5" onClick={() => window.open(item.link, "_blank", "noopener")}>
            <ExternalLink className="h-3.5 w-3.5" />
            Open original site
          </Button>
          <Button size="sm" variant="ghost" className="rounded-full gap-1.5" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
