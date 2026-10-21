import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { GitMerge, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ticketErrorText } from "./shared";

type Row = { id: number; number: string; title: string; contact: string; statusKind: string; status: string };

/**
 * "Fusionner": this ticket is merged into another open one of the same client. Its notes, time, charges
 * and files move there; it stays, closed with the status "merged".
 */
export function MergeDialog({
  open,
  onOpenChange,
  tk,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tk: { id: number; number: string; title: string; company: { id: number; name: string } };
  /** After the merge (the ticket window can follow the ticket it was merged into) */
  onDone?: (into: { id: number; number: string }) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [into, setInto] = useState<number | null>(null);
  const list = useQuery({
    queryKey: ["tickets", "merge-targets", tk.id, tk.company.id],
    queryFn: () => api.get<{ items: Row[] }>(`/tickets?view=all&company=${tk.company.id}`),
    enabled: open,
  });
  const text = q.trim().toLowerCase();
  const targets = (list.data?.items ?? []).filter((x) => x.id !== tk.id && x.statusKind !== "complete" && x.status !== "merged").filter((x) => !text || `${x.number} ${x.title} ${x.contact}`.toLowerCase().includes(text));
  const chosen = targets.find((x) => x.id === into) ?? null;
  const merge = useMutation({
    mutationFn: () => api.post<{ into: { id: number; number: string } }>(`/tickets/${tk.id}/merge`, { intoId: into }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      void qc.invalidateQueries({ queryKey: ["meetings"] });
      toast.success(t("tickets.merge.done", { number: tk.number, into: r.into.number }));
      onOpenChange(false);
      onDone?.(r.into);
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code.startsWith("merge_") ? t(`tickets.merge.errors.${e.code}`) : ticketErrorText(t, e)),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setQ("");
          setInto(null);
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-5 text-primary" /> {t("tickets.merge.title")}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-primary">{tk.number}</span> · {tk.title}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("tickets.merge.text", { client: tk.company.name })}</p>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("tickets.merge.search")} className="pl-8" autoFocus />
        </div>
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {list.isLoading && (
            <li className="flex justify-center py-6">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </li>
          )}
          {!list.isLoading && targets.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">{t("tickets.merge.none")}</li>}
          {targets.map((x) => (
            <li key={x.id}>
              <button
                type="button"
                onClick={() => setInto(x.id)}
                className={cn("flex w-full items-baseline gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-white/[0.04]", into === x.id ? "border-primary/60 bg-primary/10" : "border-transparent")}
              >
                <span className="font-mono text-xs text-primary">{x.number}</span>
                <span className="min-w-0 flex-1 truncate">{x.title}</span>
                {x.contact && <span className="truncate text-xs text-muted-foreground">{x.contact}</span>}
              </button>
            </li>
          ))}
        </ul>
        {chosen && <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs text-muted-foreground">{t("tickets.merge.summary", { from: tk.number, into: chosen.number })}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!chosen || merge.isPending} onClick={() => merge.mutate()}>
            {merge.isPending ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />} {t("tickets.merge.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
