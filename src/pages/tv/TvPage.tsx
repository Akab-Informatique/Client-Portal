import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Maximize2, Tv } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { useCan } from "@/lib/session";
import { TvManage } from "./TvManage";

/** Lobby TV sign: the pixel-art AI office (public/tv), shown live inside the portal */
export function TvPage() {
  const { t } = useTranslation();
  const can = useCan();
  const frame = useRef<HTMLIFrameElement>(null);
  const [xmasDay, setXmasDay] = useState(0); // staff preview of a day of the Christmas scene (0 = none)
  const feed = xmasDay ? `/api/tv/state?xmas=${xmasDay}` : "/api/tv/state";

  const fullscreen = () => {
    void frame.current?.requestFullscreen?.().catch(() => undefined);
  };

  return (
    <div className="relative isolate space-y-6">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Tv className="size-6 text-primary" /> {t("tv.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("tv.subtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{t("tv.livePreview")}</span>
          <Button variant="outline" size="sm" onClick={fullscreen}>
            <Maximize2 /> {t("tv.fullscreen")}
          </Button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-[min(100%,calc((100dvh-14rem)*16/9))] overflow-hidden rounded-xl border border-border bg-[#05070f]">
        <iframe
          ref={frame}
          title={t("tv.title")}
          src={`/tv/index.html?feed=${encodeURIComponent(feed)}`}
          allow="fullscreen"
          className="aspect-video w-full border-0"
        />
      </div>

      {can("tv.manage") && <TvManage xmasDay={xmasDay} onXmasDay={setXmasDay} />}
    </div>
  );
}
