import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";

type Row = { id: string; number: string; name: string; status: string; billingMode: string; tasks: number; notes: number; files: number; entries: number; imported: boolean; newId: string | null };

/** Brings the archive projects (the old format) into the new one, one at a time or all together (administrators) */
export function ArchiveImportDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["proj", "archive"], queryFn: () => api.get<Row[]>("/proj/archive") });
  const [busy, setBusy] = useState<string | null>(null);

  const one = async (r: Row): Promise<boolean> => {
    setBusy(r.id);
    try {
      await api.post(`/proj/archive/${r.id}/import`, {});
      return true;
    } catch (e) {
      toast.error(t("projBill.archive.failed", { number: r.number, code: e instanceof ApiError ? e.code : "error" }));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const refresh = async () => {
    await list.refetch();
    void qc.invalidateQueries({ queryKey: ["proj"] });
    void qc.invalidateQueries({ queryKey: ["billables"] });
  };
  const todo = (list.data ?? []).filter((r) => !r.imported);
  const all = async () => {
    let n = 0;
    for (const r of todo) if (await one(r)) n++;
    if (n) toast.success(t("projBill.archive.done", { count: n }));
    await refresh();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("projBill.archive.title")}</DialogTitle>
          <DialogDescription className="text-xs">{t("projBill.archive.text")}</DialogDescription>
        </DialogHeader>
        {list.isLoading ? (
          <Loader2 className="mx-auto my-6 size-5 animate-spin text-muted-foreground" />
        ) : (list.data ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("projBill.archive.none")}</p>
        ) : (
          <>
            <ul className="divide-y rounded-xl border">
              {(list.data ?? []).map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                  <span className="rounded-full border border-violet-400/40 bg-violet-500/10 px-2 py-px font-mono text-xs text-violet-200">{r.number}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {[t("projBill.archive.tasks", { count: r.tasks }), t("projBill.archive.notes", { count: r.notes }), t("projBill.archive.files", { count: r.files }), t("projBill.archive.entries", { count: r.entries })].join(" · ")}
                  </span>
                  {r.imported ? (
                    <button type="button" onClick={() => r.newId && onOpen(r.newId)} className="inline-flex items-center gap-1 text-xs text-emerald-300 hover:underline">
                      <Check className="size-3.5" aria-hidden /> {t("projBill.archive.imported")}
                    </button>
                  ) : (
                    <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={async () => { if (await one(r)) { toast.success(t("projBill.archive.done", { count: 1 })); await refresh(); } }}>
                      {busy === r.id ? <Loader2 className="size-3.5 animate-spin" /> : t("projBill.archive.importOne")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {todo.length > 1 && (
              <div className="flex justify-end">
                <Button type="button" disabled={busy !== null} onClick={() => void all()}>
                  {t("projBill.archive.importAll")} ({todo.length})
                </Button>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
