import { useRef } from "react";
import { format } from "date-fns";
import { useDayScreenshot } from "@/hooks/use-trades";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Upload, Trash2, Image as ImageIcon, Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/language-context";

interface DayScreenshotDialogProps {
  date: Date | null;
  onClose: () => void;
}

export function DayScreenshotDialog({ date, onClose }: DayScreenshotDialogProps) {
  const dateStr = date ? format(date, "yyyy-MM-dd") : "";
  const { screenshotQuery, saveScreenshot, deleteScreenshot } = useDayScreenshot(dateStr);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { t } = useLanguage();

  const imageBase64 = screenshotQuery.data ?? null;
  const loading = screenshotQuery.isLoading;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 3 * 1024 * 1024) {
      toast({ title: t("fileTooLarge"), description: t("max3mbAllowed"), variant: "destructive" });
      return;
    }

    const reader = new FileReader();
    reader.onload = ev => {
      const b64 = ev.target?.result as string;
      saveScreenshot.mutate(b64, {
        onSuccess: () => toast({ title: `✅ ${t("screenshotSaved")}` }),
        onError: (err: any) => toast({
          title: t("failedSaveScreenshot"),
          description: err?.message || "Check Firebase database rules for screenshots path",
          variant: "destructive",
        }),
      });
    };
    reader.readAsDataURL(file);
    // reset input so same file can be re-uploaded
    e.target.value = "";
  };

  const handleDelete = () => {
    deleteScreenshot.mutate(undefined, {
      onSuccess: () => toast({ title: t("screenshotRemoved") }),
      onError: () => toast({ title: t("failedDelete"), variant: "destructive" }),
    });
  };

  return (
    <Dialog open={!!date} onOpenChange={onClose}>
      <DialogContent className="glass-panel border-border/60 max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display">
            📸 {date ? format(date, "MMMM d, yyyy") : ""}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {loading || saveScreenshot.isPending ? (
            <div className="h-48 flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
              <span className="text-sm">{saveScreenshot.isPending ? t("saving") : t("loading")}</span>
            </div>
          ) : imageBase64 ? (
            <div className="relative group rounded-xl overflow-hidden border border-border/40">
              <img src={imageBase64} alt="Trade screenshot" className="w-full object-contain max-h-72" />
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
                <Button
                  size="sm" variant="outline"
                  onClick={() => fileRef.current?.click()}
                  className="gap-2"
                  disabled={deleteScreenshot.isPending}
                >
                   <Upload className="w-4 h-4" /> {t("replace")}
                </Button>
                <Button
                  size="sm" variant="destructive"
                  onClick={handleDelete}
                  disabled={deleteScreenshot.isPending}
                  className="gap-2"
                >
                  {deleteScreenshot.isPending
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Trash2 className="w-4 h-4" />}
                   {t("delete")}
                </Button>
              </div>
            </div>
          ) : (
            <div
              className="h-48 border-2 border-dashed border-border/50 rounded-xl flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-all"
              onClick={() => fileRef.current?.click()}
            >
              <ImageIcon className="w-10 h-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground text-center">
                {t("clickUpload")}<br />
                <span className="text-xs opacity-70">{t("max3mb")}</span>
              </p>
            </div>
          )}

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />

          {!imageBase64 && !loading && (
            <Button
              onClick={() => fileRef.current?.click()}
              className="gap-2 w-full"
              disabled={saveScreenshot.isPending}
            >
              <Upload className="w-4 h-4" /> {t("uploadScreenshot")}
            </Button>
          )}

          {screenshotQuery.isError && (
            <p className="text-xs text-destructive text-center">
              Could not load screenshot. Check Firebase rules for <code>screenshots/$uid</code> path.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
