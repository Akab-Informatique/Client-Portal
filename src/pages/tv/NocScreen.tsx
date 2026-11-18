import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Maximize2, MonitorPlay, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";

const QK = ["noc", "settings"];

/** Technical TV dashboard: live preview of /noc/index.html, its kiosk link and key (separate from the lobby's). */
export function NocScreen() {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const frame = useRef<HTMLIFrameElement>(null);
  const [rest, setRest] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const manage = can("tv.manage");
  const q = useQuery({ queryKey: QK, queryFn: () => api.get<{ displayKey: string }>("/noc/settings"), enabled: manage });
  const rotate = useMutation({
    mutationFn: () => api.post("/noc/display-key/rotate"),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK }),
    onError: () => toast.error(t("noc.link.error")),
  });
  const feed = rest ? "/api/noc/state?rest=1" : "/api/noc/state";
  const link = q.data ? `${window.location.origin}/noc/index.html?key=${q.data.displayKey}` : "";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <MonitorPlay className="size-5 text-primary" /> {t("noc.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("noc.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("noc.livePreview")}</span>
          {manage && (
            <Button variant={rest ? "default" : "outline"} size="sm" onClick={() => setRest((v) => !v)}>
              {t("noc.previewRest")}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void frame.current?.requestFullscreen?.().catch(() => undefined)}>
            <Maximize2 /> {t("noc.fullscreen")}
          </Button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-[min(100%,calc((100dvh-14rem)*16/9))] overflow-hidden rounded-xl border border-border bg-[#0a0a0b]">
        <iframe ref={frame} title={t("noc.title")} src={`/noc/index.html?feed=${encodeURIComponent(feed)}`} allow="fullscreen" className="aspect-video w-full border-0" />
      </div>

      {manage && (
        <section className="space-y-4 border-t border-border pt-6">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("noc.link.title")}</h3>
            {q.isLoading || !q.data ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 font-mono text-xs" aria-label={t("noc.link.title")} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void navigator.clipboard.writeText(link).then(() => toast.success(t("noc.link.copied")), () => toast.error(t("noc.link.error")))}
                >
                  <Copy /> {t("noc.link.copy")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
                  <RefreshCw /> {t("noc.link.rotate")}
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t("noc.link.hint")}</p>
            <p className="max-w-[75ch] text-xs text-muted-foreground">{t("noc.public")}</p>
            <p className="text-xs text-muted-foreground">{t("noc.screen")}</p>
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-medium">{t("noc.fire.title")}</h3>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t("noc.fire.s1")}</li>
              <li>{t("noc.fire.s2")}</li>
              <li>{t("noc.fire.s3")}</li>
            </ol>
          </div>
        </section>
      )}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("noc.link.rotateTitle")}</DialogTitle>
            <DialogDescription>{t("noc.link.rotateText")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              {t("noc.link.cancel")}
            </Button>
            <Button
              onClick={() => {
                setConfirm(false);
                rotate.mutate();
              }}
            >
              {t("noc.link.rotate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
