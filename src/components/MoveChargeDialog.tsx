import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";

type TicketHit = { id: number; number: string; title: string; company?: { name: string } };
type ProjectHit = { id: string; number: string; name: string; client: { name: string } | null };

/**
 * Puts a charge that is not approved yet on another ticket or on a project. `path` is the move route of the
 * place the charge is on now (`/tickets/:id/charges/:cid/move` or `/projects/:id/charges/:cid/move`).
 */
export function MoveChargeDialog({
  name,
  path,
  exclude,
  onClose,
  onMoved,
}: {
  name: string;
  path: string;
  /** Where it is now, left out of the search */
  exclude: { ticketId?: number; projectId?: string };
  onClose: () => void;
  onMoved: () => void;
}) {
  const { t } = useTranslation();
  const can = useCan();
  const canProject = can("projects.edit") && can("projects.view");
  const canTicket = can("tickets.edit");
  const [tab, setTab] = useState<"ticket" | "project">(canTicket ? "ticket" : "project");
  const [q, setQ] = useState("");
  const text = q.trim();
  const tickets = useQuery({
    queryKey: ["move-charge", "tickets", text],
    queryFn: () => api.get<{ items: TicketHit[] }>(`/tickets/search?q=${encodeURIComponent(text)}`),
    enabled: tab === "ticket" && text.length >= 2,
  });
  const projects = useQuery({
    queryKey: ["move-charge", "projects", text],
    queryFn: () => api.get<ProjectHit[]>(`/projects?view=all&status=open${text ? `&q=${encodeURIComponent(text)}` : ""}`),
    enabled: tab === "project",
  });
  const move = useMutation({
    mutationFn: (to: { ticketId: number } | { projectId: string }) => api.post<{ to: string }>(path, to),
    onSuccess: (r) => {
      toast.success(t("chargeMove.moved", { to: r.to }));
      onMoved();
      onClose();
    },
    onError: (e) => {
      const code = e instanceof ApiError ? (e.code ?? e.message) : "";
      toast.error(code && t(`chargeMove.errors.${code}`, { defaultValue: "" }) ? t(`chargeMove.errors.${code}`) : t("common.error", { defaultValue: "Error" }));
    },
  });
  const ticketRows = (tickets.data?.items ?? []).filter((x) => x.id !== exclude.ticketId);
  const projectRows = (projects.data ?? []).filter((x) => x.id !== exclude.projectId).slice(0, 30);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("chargeMove.title")}</DialogTitle>
          <DialogDescription>{t("chargeMove.text", { name })}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 rounded-lg border p-0.5 text-sm">
          {([["ticket", canTicket], ["project", canProject]] as const)
            .filter(([, ok]) => ok)
            .map(([k]) => (
              <button key={k} type="button" onClick={() => (setTab(k), setQ(""))} className={cn("flex-1 rounded-md px-3 py-1.5", tab === k ? "bg-accent font-medium text-primary" : "text-muted-foreground hover:text-foreground")}>
                {t(k === "ticket" ? "chargeMove.tabTicket" : "chargeMove.tabProject")}
              </button>
            ))}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input autoFocus className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t(tab === "ticket" ? "chargeMove.searchTicket" : "chargeMove.searchProject")} />
        </div>
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {(tickets.isFetching || projects.isFetching) && <li className="flex justify-center py-3"><Loader2 className="size-4 animate-spin text-muted-foreground" /></li>}
          {tab === "ticket" &&
            text.length >= 2 &&
            ticketRows.map((x) => (
              <Row key={x.id} number={x.number} title={x.title} sub={x.company?.name} disabled={move.isPending} onPick={() => move.mutate({ ticketId: x.id })} />
            ))}
          {tab === "project" && projectRows.map((x) => <Row key={x.id} number={x.number} title={x.name} sub={x.client?.name} disabled={move.isPending} onPick={() => move.mutate({ projectId: x.id })} />)}
          {((tab === "ticket" && text.length >= 2 && !tickets.isFetching && ticketRows.length === 0) || (tab === "project" && !projects.isFetching && projectRows.length === 0)) && (
            <li className="py-3 text-center text-sm text-muted-foreground">{t("chargeMove.none")}</li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function Row({ number, title, sub, disabled, onPick }: { number: string; title: string; sub?: string | null; disabled: boolean; onPick: () => void }) {
  const { t } = useTranslation();
  return (
    <li>
      <button type="button" disabled={disabled} onClick={onPick} className="flex w-full items-center gap-3 rounded-lg border bg-background/30 px-3 py-2 text-left text-sm hover:border-primary/50 disabled:opacity-50">
        <span className="shrink-0 font-mono text-xs text-primary">{number}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{title}</span>
          {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{t("chargeMove.move")}</span>
      </button>
    </li>
  );
}
