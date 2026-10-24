import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { money } from "@/pages/crm/shared";

type Log = {
  records: { id: string; runId: string; kind: "timesheet" | "expense"; label: string; previous: { status?: string; comment?: string | null; decidedAt?: string | null }; at: string }[];
  lines: { id: string; client: string | null; kind: string; date: string; description: string; amountCents: number; contractName: string | null }[];
};

/** What the temporary clean-up set aside: found by search, kept until it is purged. */
export function CleanupLog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["admin", "billing", "cleanup", "log", q], queryFn: () => api.get<Log>(`/billing/cleanup/log?q=${encodeURIComponent(q)}`) });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("billing.cleanup.logTitle")}</DialogTitle>
        </DialogHeader>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("billing.cleanup.search")} />
        {isLoading || !data ? (
          <Loader2 className="mx-auto my-6 size-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-5 text-sm">
            <section>
              <h4 className="mb-1 font-semibold">{t("billing.cleanup.logRecords", { count: data.records.length })}</h4>
              <ul className="divide-y divide-border/50 rounded-lg border">
                {data.records.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 px-3 py-1.5 text-xs">
                    <span className="w-24 shrink-0 uppercase text-muted-foreground">{t(`billing.cleanup.kind_${r.kind}`)}</span>
                    <span className="min-w-0 flex-1">{r.label}</span>
                    <span className="text-muted-foreground">{t("billing.cleanup.was", { status: r.previous.status ?? "—" })}</span>
                    <span className="text-muted-foreground">{dateTime(r.at)}</span>
                  </li>
                ))}
                {!data.records.length && <li className="px-3 py-3 text-center text-xs text-muted-foreground">{t("billing.cleanup.none")}</li>}
              </ul>
            </section>
            <section>
              <h4 className="mb-1 font-semibold">{t("billing.cleanup.logLines", { count: data.lines.length })}</h4>
              <ul className="divide-y divide-border/50 rounded-lg border">
                {data.lines.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-x-3 px-3 py-1.5 text-xs">
                    <span className="w-24 shrink-0 uppercase text-muted-foreground">{l.kind}</span>
                    <span className="w-40 shrink-0 truncate">{l.client}</span>
                    <span className="min-w-0 flex-1 truncate">{l.contractName ? `${l.contractName} — ` : ""}{l.description}</span>
                    <span className="font-mono text-muted-foreground">{l.date}</span>
                    <span className="w-24 text-right font-mono">{money(l.amountCents, i18n.language)}</span>
                  </li>
                ))}
                {!data.lines.length && <li className="px-3 py-3 text-center text-xs text-muted-foreground">{t("billing.cleanup.none")}</li>}
              </ul>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
