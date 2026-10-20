import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Database, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { since, useSyncStatus, type SyncStatus } from "@/pages/crm/shared";

/**
 * Where the data comes from, always in view: synced with Autotask (green;
 * amber when the last sync failed), or the portal's local database.
 */
export function SyncBadge() {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const { data: s } = useSyncStatus();
  const sync = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error: string | null }>("/crm/sync"),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["crm"] });
      void qc.invalidateQueries({ queryKey: ["tickets", "companies"] });
      if (r.ok) toast.success(t("sync.done"));
      else toast.error(t("sync.error", { detail: r.error ?? "" }));
    },
    onError: () => toast.error(t("common.error")),
  });
  if (!s) return null;
  const linked = s.mode === "autotask";
  const failing = linked && s.ok === false;
  const own = s.mode === "local";
  const tone = !linked ? "local" : failing ? "warn" : "ok";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-colors",
            tone === "ok" && "border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-300 hover:bg-emerald-500/15",
            tone === "warn" && "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15",
            tone === "local" && "border-sky-500/30 bg-sky-500/[0.07] text-sky-300 hover:bg-sky-500/15",
          )}
        >
          <span className="relative flex size-2">
            {tone === "ok" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-40 [animation-duration:2.5s]" />}
            <span className={cn("relative inline-flex size-2 rounded-full", tone === "ok" ? "bg-emerald-400" : tone === "warn" ? "bg-amber-400" : "bg-sky-400")} />
          </span>
          <span className="hidden md:inline">{linked ? (failing ? t("sync.failed") : t("sync.autotask")) : own ? t("sync.local") : t("sync.sample")}</span>
          <span className="md:hidden">{linked ? t("sync.autotaskShort") : t("sync.sampleShort")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Database className="size-4 text-primary" /> {t("sync.title")}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">{linked ? t("sync.textAutotask", { every: s.every }) : own ? t("sync.textLocal") : t("sync.textSample")}</p>
        <Details s={s} lang={i18n.language} />
        {can("crm.edit") && (
          <Button size="sm" variant="outline" className="w-full" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t("sync.now")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Details({ s, lang }: { s: SyncStatus; lang: string }) {
  const { t } = useTranslation();
  return (
    <dl className="space-y-1.5 rounded-lg border bg-background/40 p-2.5 text-xs">
      <div className="flex justify-between gap-2">
        <dt className="text-muted-foreground">{t("sync.lastSync")}</dt>
        <dd className="font-medium">{s.lastSync ? since(s.lastSync, lang) : t("sync.never")}</dd>
      </div>
      {s.counts && <dd className="text-muted-foreground">{t("sync.counts", s.counts)}</dd>}
      {s.ok === false && s.error && <dd className="break-words text-amber-300">{t("sync.error", { detail: s.error })}</dd>}
    </dl>
  );
}
