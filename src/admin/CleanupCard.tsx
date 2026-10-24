import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, Eraser, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useConfirm } from "@/components/ConfirmDialog";
import { Card } from "./BillingSection";
import { CleanupLog } from "./CleanupLog";

type Counts = { contractLines: number; timesheets: number; expenses: number; keptLines: number; keptRecords: number };

/** Temporary: tidy the approval pages without touching what people entered. */
export function CleanupCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const counts = useQuery({ queryKey: ["admin", "billing", "cleanup"], queryFn: () => api.get<Counts>("/billing/cleanup") });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["admin", "billing", "cleanup"] });
    void qc.invalidateQueries({ queryKey: ["billables"] });
    void qc.invalidateQueries({ queryKey: ["time"] });
  };
  const contracts = useMutation({
    mutationFn: () => api.post<{ changed: number }>("/billing/cleanup/contracts"),
    onSuccess: (r) => (toast.success(t("billing.cleanup.contractsDone", { count: r.changed })), done()),
    onError: () => toast.error(t("billing.cleanup.failed")),
  });
  const approvals = useMutation({
    mutationFn: () => api.post<{ timesheets: number; expenses: number }>("/billing/cleanup/approvals"),
    onSuccess: (r) => (toast.success(t("billing.cleanup.approvalsDone", { sheets: r.timesheets, expenses: r.expenses })), done()),
    onError: () => toast.error(t("billing.cleanup.failed")),
  });
  const purge = useMutation({
    mutationFn: () => api.post<{ lines: number; records: number }>("/billing/cleanup/purge"),
    onSuccess: (r) => (toast.success(t("billing.cleanup.purged", { lines: r.lines, records: r.records })), done()),
    onError: () => toast.error(t("billing.cleanup.failed")),
  });
  const [showLog, setShowLog] = useState(false);
  const c = counts.data;
  return (
    <Card title={t("billing.cleanup.title")} text={t("billing.cleanup.text")}>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          disabled={contracts.isPending}
          onClick={() => void confirm({ title: t("billing.cleanup.contractsConfirm"), description: t("billing.cleanup.contractsHint"), destructive: true }).then((ok) => ok && contracts.mutate())}
        >
          {contracts.isPending ? <Loader2 className="size-4 animate-spin" /> : <Eraser className="size-4" />} {t("billing.cleanup.contracts", { count: c?.contractLines ?? 0 })}
        </Button>
        <Button
          variant="outline"
          disabled={approvals.isPending}
          onClick={() => void confirm({ title: t("billing.cleanup.approvalsConfirm"), description: t("billing.cleanup.approvalsHint"), destructive: true }).then((ok) => ok && approvals.mutate())}
        >
          {approvals.isPending ? <Loader2 className="size-4 animate-spin" /> : <Eraser className="size-4" />} {t("billing.cleanup.approvals", { sheets: c?.timesheets ?? 0, expenses: c?.expenses ?? 0 })}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t pt-3 text-xs text-muted-foreground">
        <span>{t("billing.cleanup.kept", { lines: c?.keptLines ?? 0, records: c?.keptRecords ?? 0 })}</span>
        <Button size="sm" variant="outline" onClick={() => setShowLog(true)}>
          <Archive className="size-4" /> {t("billing.cleanup.view")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={purge.isPending || !(c?.keptLines || c?.keptRecords)}
          onClick={() => void confirm({ title: t("billing.cleanup.purgeConfirm"), description: t("billing.cleanup.purgeHint"), destructive: true }).then((ok) => ok && purge.mutate())}
        >
          {purge.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} {t("billing.cleanup.purge")}
        </Button>
      </div>
      {showLog && <CleanupLog onClose={() => setShowLog(false)} />}
    </Card>
  );
}
