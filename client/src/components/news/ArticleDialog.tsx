/**
 * In-app news reader (TradingView style): the FULL story is extracted
 * server-side (/api/news?article=…) and rendered right here on the site —
 * not just the 10-word summary from the feed. Falls back to the summary +
 * a source link when the publisher page can't be parsed (paywall / JS-only).
 * A Translate button (next to Open site / Close) pulls the same article
 * translated server-side and toggles back to the original at will.
 */
import { useEffect, useState } from "react";
import { Globe2, Clock3, ExternalLink, Languages, X, Loader2, FileText } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SYMBOL_COLOR, type NewsItem } from "@/lib/news-api";
import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";

interface ArticleData {
  ok: boolean;
  title?: string;
  paragraphs: string[];
  error?: string;
}

export function ArticleDialog({ item, onClose }: { item: NewsItem | null; onClose: () => void }) {
  const { language } = useLanguage();
  const [showOriginal, setShowOriginal] = useState(false);
  const [art, setArt] = useState<{ loading: boolean; data: ArticleData | null }>({ loading: false, data: null });
  // translated copy of the full article (server-side extraction + translate)
  const [trans, setTrans] = useState<{ loading: boolean; data: ArticleData | null; on: boolean }>({
    loading: false,
    data: null,
    on: false,
  });
  // which language the translate bar is currently showing
  const [transLang, setTransLang] = useState<string>("en");

  // fetch the full article text every time a story is opened
  useEffect(() => {
    if (!item) {
      setArt({ loading: false, data: null });
      setTrans({ loading: false, data: null, on: false });
      setTransLang("en");
      return;
    }
    let dead = false;
    setArt({ loading: true, data: null });
    setTrans({ loading: false, data: null, on: false });
    setTransLang("en");
    setShowOriginal(false);
    fetch(`/api/news?article=${encodeURIComponent(item.link)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: ArticleData) => { if (!dead) setArt({ loading: false, data: d }); })
      .catch(() => { if (!dead) setArt({ loading: false, data: null }); });
    return () => { dead = true; };
  }, [item]);

  // translate bar under the story: pick any of the app languages; EN = original
  const translateTo = (lang: string) => {
    if (!item) return;
    if (lang === "en") {
      setTransLang("en");
      setTrans((p) => ({ ...p, on: false }));
      return;
    }
    if (trans.loading) return;
    if (trans.data && transLang === lang) {
      setTrans((p) => ({ ...p, on: !p.on }));
      return;
    }
    setTransLang(lang);
    setTrans({ loading: true, data: null, on: true });
    fetch(`/api/news?article=${encodeURIComponent(item.link)}&lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: ArticleData) => setTrans({ loading: false, data: d, on: true }))
      .catch(() => setTrans({ loading: false, data: null, on: false }));
  };

  if (!item) return null;

  const translated = language !== "en" && !!item.titleEn;
  const fromFeed = !!item.fullText && item.fullText.length > item.summary.length + 100;
  const full = fromFeed || (art.data?.ok === true && art.data.paragraphs.length > 0);
  // translated view takes over the body when switched on
  const transOk = trans.on && !!trans.data?.ok && trans.data.paragraphs.length > 0;

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
          {transOk ? trans.data!.title : showOriginal && item.titleEn ? item.titleEn : item.title}
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

        <div className="mt-3 text-sm leading-relaxed text-foreground/90">
          {trans.on && trans.loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-xs">Translating the article…</span>
            </div>
          ) : transOk ? (
            <div className="max-h-[52vh] space-y-3 overflow-y-auto pr-1">
              {trans.data!.paragraphs.map((p, i) => (
                <p key={i} className="leading-relaxed">{p}</p>
              ))}
            </div>
          ) : trans.on && trans.data && !trans.data.ok ? (
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Translation isn't available for this story — read it on the source site below.
            </p>
          ) : fromFeed ? (
            <div className="max-h-[52vh] overflow-y-auto whitespace-pre-line pr-1">{item.fullText}</div>
          ) : art.loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-xs">Loading the full article…</span>
            </div>
          ) : full ? (
            <div className="max-h-[52vh] space-y-3 overflow-y-auto pr-1">
              {art.data!.paragraphs.map((p, i) => (
                <p key={i} className="leading-relaxed">{p}</p>
              ))}
            </div>
          ) : (
            <>
              <div className="whitespace-pre-line">{item.summary || "—"}</div>
              {art.data && !art.data.ok && (
                <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  The publisher doesn't allow this story to be displayed here — read it on the source site below.
                </p>
              )}
            </>
          )}
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

        {/* translate the whole story — right under the news, all app languages */}
        <div className="mt-3 rounded-xl border border-border/50 bg-muted/30 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              <Languages className="h-3.5 w-3.5" />
              Translate:
            </span>
            {([["en", "🇬🇧"], ["ru", "🇷🇺"], ["uz", "🇺🇿"], ["ar", "🇸🇦"]] as const).map(([code, flag]) => (
              <button
                key={code}
                onClick={() => translateTo(code)}
                disabled={trans.loading}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-60",
                  trans.on && transLang === code && trans.data?.ok
                    ? "border-sky-500/60 bg-sky-500/15 text-sky-300"
                    : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                <span aria-hidden>{flag}</span>
                {code.toUpperCase()}
                {trans.loading && transLang === code && <Loader2 className="h-3 w-3 animate-spin" />}
              </button>
            ))}
            {trans.on && trans.data?.ok && (
              <button
                onClick={() => setTrans((p) => ({ ...p, on: false }))}
                className="ml-auto text-[11px] font-semibold text-sky-400 underline-offset-2 hover:underline"
              >
                Show original
              </button>
            )}
          </div>
          {trans.on && trans.data && !trans.data.ok && (
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
              Translation isn't available for this story — read it on the source site.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
