import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Database, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { useSyncStatus } from "@/pages/crm/shared";

/**
 * Where the data comes from, always in view: the portal's own database, or
 * (development) the sample data, which can be copied again.
 */
export function SyncBadge() {
  const { t } = useTranslation();
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
  const sample = s.mode === "sample";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex h-8 items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/[0.07] px-3 text-xs font-medium text-sky-300 transition-colors hover:bg-sky-500/15">
          <span className="relative flex size-2">
            <span className="relative inline-flex size-2 rounded-full bg-sky-400" />
          </span>
          <span className="hidden md:inline">{sample ? t("sync.sample") : t("sync.local")}</span>
          <span className="md:hidden">{t("sync.sampleShort")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Database className="size-4 text-primary" /> {t("sync.title")}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">{sample ? t("sync.textSample") : t("sync.textLocal")}</p>
        {sample && can("crm.edit") && (
          <Button size="sm" variant="outline" className="w-full" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t("sync.now")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
