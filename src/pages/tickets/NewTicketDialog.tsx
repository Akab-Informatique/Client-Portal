import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Ticket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { CompanyPicker, ContactPicker, useCompanies } from "./pickers";
import { PRIORITY_STYLE, useChoiceText, type TicketList, type TicketSummary, ticketErrorText } from "./shared";

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Quick ticket creation: the essentials first, assigned to me by default. */
export function NewTicketDialog({
  open,
  onOpenChange,
  facets,
  onCreated,
  initial,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  facets: TicketList["facets"];
  onCreated: (id: number) => void;
  /** Pre-filled title / description (e.g. a ticket made from an email). */
  initial?: { title?: string; description?: string; companyId?: number | null; contactId?: string | null };
}) {
  const { t } = useTranslation();
  const txt = useChoiceText();
  const { data: companies = [] } = useCompanies();
  const qc = useQueryClient();
  const me = useMe();
  const empty = () => ({
    companyId: initial?.companyId ? String(initial.companyId) : "",
    contactId: (initial?.contactId ?? null) as string | null,
    title: (initial?.title ?? "").slice(0, 250),
    description: (initial?.description ?? "").slice(0, 8000),
    priority: (facets.priorities.find((p) => p.kind === "medium") ?? facets.priorities[0])?.value ?? "",
    queue: facets.queues[0]?.value ?? "",
    assigneeId: me.id as string,
    dueDate: inDays(2),
    startDate: "",
  });
  const [f, setF] = useState(empty);
  useEffect(() => {
    if (open) setF(empty());
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.post<TicketSummary>("/tickets", {
        ...f,
        companyId: Number(f.companyId),
        contactId: f.contactId,
        assigneeId: f.assigneeId === "none" ? null : f.assigneeId,
        startDate: f.startDate || null,
      }),
    onSuccess: (tk) => {
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      toast.success(t("tickets.created", { number: tk.number }));
      onOpenChange(false);
      onCreated(tk.id);
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ticket className="size-5 text-primary" /> {t("tickets.new")}
          </DialogTitle>
          <DialogDescription>{t("tickets.newText")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="nt-company">{t("tickets.fields.company")}</Label>
              <CompanyPicker
                triggerClassName="h-9 rounded-md border bg-transparent px-3 text-sm dark:bg-input/30"
                value={companies.find((c) => String(c.id) === f.companyId) ?? null}
                companies={companies}
                onChange={(c) => setF({ ...f, companyId: String(c.id), contactId: null })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="nt-contact">{t("tickets.fields.contact")}</Label>
              <ContactPicker
                triggerClassName="h-9 rounded-md border bg-transparent px-3 text-sm dark:bg-input/30"
                canCreate
                companyId={f.companyId ? Number(f.companyId) : null}
                value={f.contactId}
                onChange={(c) => setF({ ...f, contactId: c?.id ?? null })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="nt-title">{t("tickets.fields.title")}</Label>
            <Input id="nt-title" required autoFocus maxLength={250} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="nt-desc">{t("tickets.description")}</Label>
            <Textarea id="nt-desc" rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </div>

          <div className="space-y-2">
            <Label>{t("tickets.fields.priority")}</Label>
            <div className="grid grid-cols-4 gap-2">
              {facets.priorities.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={f.priority === p.value}
                  onClick={() => setF({ ...f, priority: p.value })}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-lg border py-2 text-sm transition-colors",
                    f.priority === p.value ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10 font-medium" : "text-muted-foreground hover:bg-accent/50",
                  )}
                >
                  <span className={cn("size-2 rounded-full", PRIORITY_STYLE[p.kind].dot)} /> {txt.priority(p)}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="nt-queue">{t("tickets.fields.queue")}</Label>
              <Select value={f.queue} onValueChange={(v) => setF({ ...f, queue: v })}>
                <SelectTrigger id="nt-queue" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {facets.queues.map((q) => (
                    <SelectItem key={q.value} value={q.value}>
                      {q.label ?? q.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="nt-assignee">{t("tickets.fields.assignee")}</Label>
              <Select value={f.assigneeId} onValueChange={(v) => setF({ ...f, assigneeId: v })}>
                <SelectTrigger id="nt-assignee" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" className="max-h-72">
                  <SelectItem value="none">{t("tickets.unassigned")}</SelectItem>
                  {facets.technicians.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                      {p.id === me.id && ` (${t("tickets.me")})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="nt-start" className="flex items-center gap-1.5">
                {t("tickets.fields.start")}
                <span className="rounded border border-[color:var(--gold)]/40 px-1 text-[9px] font-semibold text-primary">{t("tickets.portalTag")}</span>
              </Label>
              <Input id="nt-start" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="nt-due">{t("tickets.fields.due")}</Label>
              <Input id="nt-due" type="date" required value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending || !f.companyId || !f.title.trim()} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {create.isPending && <Loader2 className="size-4 animate-spin" />} {t("tickets.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
