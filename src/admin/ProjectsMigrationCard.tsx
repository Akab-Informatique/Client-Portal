import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, SearchCheck, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useConfirm } from "@/components/ConfirmDialog";
import { Card } from "./BillingSection";

type Seg = { count: number; cents: number };
type Check = {
  archiveProjects: number;
  notImported: { number: string; name: string }[];
  toRename: number;
  wrongKind: number;
  stillArchive: number;
  inNewFormat: { pending: Seg; approved: Seg; posted: Seg; excluded: Seg };
  missingLines: number;
  saleToMove: number;
  sample: { number: string | null; description: string; status: string; kind: string; amountCents: number; date: string }[];
  ok: boolean;
};
type Repair = { imported: number; renamed: number; kindChanged: number; saleMoved: number; errors: string[]; after: Check };

const money = (c: number) => (c / 100).toLocaleString(undefined, { style: "currency", currency: "CAD" });

/** Temporary: did the archive projects' work to bill come over? Check (read only), then fix. */
export function ProjectsMigrationCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const check = useQuery({ queryKey: ["admin", "billing", "projects-check"], queryFn: () => api.get<Check>("/billing/cleanup/projects"), enabled: false });
  const repair = useMutation({
    mutationFn: () => api.post<Repair>("/billing/cleanup/projects"),
    onSuccess: (r) => {
      toast.success(t("projMig.done", { imported: r.imported, renamed: r.renamed, kind: r.kindChanged, sale: r.saleMoved }));
      if (r.errors.length) toast.error(t("projMig.errors", { list: r.errors.join(" · ") }));
      qc.setQueryData(["admin", "billing", "projects-check"], r.after);
      void qc.invalidateQueries({ queryKey: ["billables"] });
      void qc.invalidateQueries({ queryKey: ["proj"] });
    },
    onError: () => toast.error(t("projMig.failed")),
  });
  const c = check.data;
  const n = c?.inNewFormat;
  return (
    <Card title={t("projMig.title")} text={t("projMig.text")}>
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" disabled={check.isFetching} onClick={() => void check.refetch()}>
          {check.isFetching ? <Loader2 className="size-4 animate-spin" /> : <SearchCheck className="size-4" />} {t("projMig.check")}
        </Button>
        <Button variant="outline" disabled={repair.isPending} onClick={() => void confirm({ title: t("projMig.repair"), description: t("projMig.text") }).then((ok) => ok && repair.mutate())}>
          {repair.isPending ? <Loader2 className="size-4 animate-spin" /> : <Wrench className="size-4" />} {t("projMig.repair")}
        </Button>
      </div>
      {c && n && (
        <div className="space-y-1 border-t pt-3 text-sm">
          <p className={c.ok ? "font-medium text-emerald-400" : "font-medium text-amber-300"}>{c.ok ? t("projMig.ok") : t("projMig.notOk")}</p>
          {c.notImported.length > 0 && (
            <p>
              {t("projMig.notImported", { count: c.notImported.length })} ({c.notImported.map((p) => p.number).join(", ")})
            </p>
          )}
          {c.toRename > 0 && <p>{t("projMig.toRename", { count: c.toRename })}</p>}
          {c.wrongKind > 0 && <p>{t("projMig.wrongKind", { count: c.wrongKind })}</p>}
          {c.missingLines > 0 && <p>{t("projMig.missing", { count: c.missingLines })}</p>}
          {c.saleToMove > 0 && <p>{t("projMig.sale", { count: c.saleToMove })}</p>}
          {c.stillArchive > 0 && <p className="text-muted-foreground">{t("projMig.stillArchive", { count: c.stillArchive })}</p>}
          <p className="text-muted-foreground">{t("projMig.inNew", { p: n.pending.count, pa: money(n.pending.cents), a: n.approved.count, aa: money(n.approved.cents), f: n.posted.count })}</p>
          {c.sample.length > 0 && (
            <ul className="max-h-48 overflow-y-auto text-xs text-muted-foreground">
              {c.sample.map((s, i) => (
                <li key={i}>
                  {s.number} · {s.date} · {s.status} · {s.kind} · {money(s.amountCents)} · {s.description}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
