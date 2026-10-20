import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText, Loader2, Paperclip, Ticket, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiTextarea } from "@/components/AiPolish";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { fileToBase64 } from "../outlook/shared";
import { CompanyPicker, ContactPicker, useCompanies, useContracts } from "./pickers";
import { PRIORITY_STYLE, useChoiceText, type TicketList, type TicketSummary, ticketErrorText } from "./shared";

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
/** Same limit as the API (Autotask takes a few megabytes per attachment) */
const MAX_FILE = 5 * 1024 * 1024;
const sizeText = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} Ko` : `${(b / 1024 / 1024).toFixed(1)} Mo`);

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
  initial?: { title?: string; description?: string; companyId?: number | null; contactId?: string | null; source?: string };
}) {
  const { t } = useTranslation();
  const txt = useChoiceText();
  const { data: companies = [] } = useCompanies();
  const qc = useQueryClient();
  const me = useMe();
  const can = useCan();
  const empty = () => ({
    companyId: initial?.companyId ? String(initial.companyId) : "",
    contactId: (initial?.contactId ?? null) as string | null,
    // by hand it is a phone ticket; an email (or a text) says so
    source: initial?.source ?? "phone",
    title: (initial?.title ?? "").slice(0, 250),
    description: (initial?.description ?? "").slice(0, 8000),
    priority: (facets.priorities.find((p) => p.kind === "medium") ?? facets.priorities[0])?.value ?? "",
    // null: not chosen yet (the client's default contract is picked once loaded); "": none
    contractId: null as string | null,
    assigneeId: me.id as string,
    dueDate: inDays(2),
    dueTime: "17:00",
    startDate: "",
    startTime: "",
  });
  const [f, setF] = useState(empty);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setF(empty());
      setFiles([]);
    }
  }, [open]);

  // the client's contracts: its default one is picked (still changeable)
  const { data: contracts, isFetching: loadingContracts } = useContracts(f.companyId ? Number(f.companyId) : null);
  useEffect(() => {
    if (f.contractId === null && contracts) setF((x) => ({ ...x, contractId: contracts.find((k) => k.isDefault)?.id ?? "" }));
  }, [contracts, f.contractId]);

  const addFiles = (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    for (const x of picked.filter((x) => x.size > MAX_FILE)) toast.error(t("tickets.attachTooBig", { name: x.name }));
    setFiles((old) => [...old, ...picked.filter((x) => x.size <= MAX_FILE && !old.some((o) => o.name === x.name && o.size === x.size))]);
  };

  const create = useMutation({
    mutationFn: () =>
      api.post<TicketSummary>("/tickets", {
        ...f,
        companyId: Number(f.companyId),
        contactId: f.contactId,
        contractId: f.contractId || null,
        assigneeId: f.assigneeId === "none" ? null : f.assigneeId,
        // the due day at the time chosen (local time)
        dueAt: new Date(`${f.dueDate}T${f.dueTime || "17:00"}:00`).toISOString(),
        dueTime: undefined,
        startDate: f.startDate || null,
        startTime: f.startDate && f.startTime ? f.startTime : null,
      }),
    onSuccess: async (tk) => {
      // the files, one at a time, once the ticket exists
      if (files.length) {
        setUploading(true);
        for (const x of files) {
          try {
            await api.post(`/tickets/${tk.id}/attachments`, { name: x.name, contentType: x.type || "application/octet-stream", data: await fileToBase64(x) });
          } catch {
            toast.error(t("tickets.attachFailed", { name: x.name }));
          }
        }
        setUploading(false);
      }
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      toast.success(t("tickets.created", { number: tk.number }));
      onOpenChange(false);
      onCreated(tk.id);
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const busy = create.isPending || uploading;

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
                canCreate={can("tickets.clients")}
                onChange={(c) => setF({ ...f, companyId: String(c.id), contactId: null, contractId: null })}
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
            <AiTextarea id="nt-desc" rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </div>

          <div className="space-y-2">
            <Label>{t("tickets.attachments")}</Label>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                addFiles(e.dataTransfer.files);
              }}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg border border-dashed px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-[color:var(--gold)]/50 hover:text-foreground",
                dragging && "border-[color:var(--gold)]/70 bg-[color:var(--gold)]/[0.06] text-foreground",
              )}
            >
              <Paperclip className="size-4 shrink-0 text-primary" />
              <span className="flex-1">{t("tickets.attachHint")}</span>
              <span className="text-[11px]">{t("tickets.attachLimit")}</span>
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {files.map((x) => (
                  <li key={`${x.name}-${x.size}`} className="flex max-w-full items-center gap-1.5 rounded-md border bg-background/40 py-1 pl-2 pr-1 text-xs">
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{x.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{sizeText(x.size)}</span>
                    <button
                      type="button"
                      aria-label={t("tickets.attachRemove", { name: x.name })}
                      onClick={() => setFiles((old) => old.filter((o) => o !== x))}
                      className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
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

          {(facets.sources ?? []).length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="nt-source">{t("tickets.fields.source")}</Label>
              <div id="nt-source" className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("tickets.fields.source")}>
                {(facets.sources ?? []).map((x) => (
                  <button
                    key={x.value}
                    type="button"
                    role="radio"
                    aria-checked={f.source === x.value}
                    onClick={() => setF({ ...f, source: x.value })}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                      f.source === x.value ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10 font-medium" : "text-muted-foreground hover:bg-accent/50",
                    )}
                  >
                    {x.label ?? x.value}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="nt-contract" className="flex items-center gap-1.5">
                {t("tickets.contract")}
                {loadingContracts && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
              </Label>
              <Select value={f.contractId || "none"} onValueChange={(v) => setF({ ...f, contractId: v === "none" ? "" : v })} disabled={!f.companyId}>
                <SelectTrigger id="nt-contract" className="w-full">
                  <SelectValue>
                    {/* the name only (the list also shows "default" and the end date) */}
                    {!f.companyId ? (
                      <span className="text-muted-foreground">{t("tickets.pickCompanyFirst")}</span>
                    ) : (
                      (contracts?.find((k) => k.id === f.contractId)?.name ?? (contracts?.length ? t("tickets.noContract") : t("tickets.noContracts")))
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent position="popper" className="max-h-72">
                  <SelectItem value="none">{contracts?.length ? t("tickets.noContract") : t("tickets.noContracts")}</SelectItem>
                  {(contracts ?? []).map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.name}
                      {(k.isDefault || k.endDate) && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {[k.isDefault && t("tickets.contractDefault"), k.endDate && t("tickets.contractEnds", { date: k.endDate })].filter(Boolean).join(" · ")}
                        </span>
                      )}
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
              <div className="flex gap-2">
                <Input id="nt-start" type="date" className="min-w-0 flex-1" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
                <Input
                  type="time"
                  className="w-32 shrink-0"
                  disabled={!f.startDate}
                  value={f.startTime}
                  onChange={(e) => setF({ ...f, startTime: e.target.value })}
                  aria-label={t("tickets.startTime")}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="nt-due">{t("tickets.fields.due")}</Label>
              <div className="flex gap-2">
                <Input id="nt-due" type="date" required className="min-w-0 flex-1" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
                <Input type="time" required className="w-32 shrink-0" value={f.dueTime} onChange={(e) => setF({ ...f, dueTime: e.target.value })} aria-label={t("tickets.due.time")} />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !f.companyId || !f.title.trim()} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {busy && <Loader2 className="size-4 animate-spin" />} {uploading ? t("tickets.attaching") : t("tickets.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
