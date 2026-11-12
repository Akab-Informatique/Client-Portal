import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Kanban, Plus, Search, Ticket } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Pager, pageSizeOf } from "@/components/Pager";
import { api } from "@/lib/api";
import { longDate, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PageHeader, Pane, Segmented } from "./ui";
import { DELEGATE_API, PriorityBadge, StatusBadge, dayOf, isNotSelfManaged, useDelegateError, type DelegateList, type DelegateOptions } from "./delegateShared";
import { DelegateTicketDialog } from "./DelegateTicket";

type TabFilter = "open" | "closed" | "all";
const TABS: TabFilter[] = ["open", "closed", "all"];
const PAGE_SIZE = 25;

/** A due day as the client reads it, red when passed on a ticket still open */
function DueCell({ value, complete }: { value: string | null; complete: boolean }) {
  const { t } = useTranslation();
  const day = dayOf(value);
  if (!day) return <span className="text-muted-foreground">{t("selfManaged.delegate.noDue")}</span>;
  const [y, m, d] = day.split("-").map(Number);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const late = !complete && day < today;
  return <span className={cn(late && "font-medium text-destructive")}>{longDate(new Date(y, m - 1, d))}</span>;
}

/** Ticket management of a self-managed company: its delegate works the tickets here. */
export function DelegatePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errorText = useDelegateError();
  const [params, setParams] = useSearchParams();
  const set = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
        return p;
      },
      { replace: true },
    );
  const status = (TABS.includes(params.get("status") as TabFilter) ? params.get("status") : "open") as TabFilter;
  const akab = params.get("akab") === "1";
  const q = params.get("q") ?? "";
  const page = Math.max(1, Math.floor(Number(params.get("page"))) || 1);
  const size = pageSizeOf(params.get("size"), PAGE_SIZE);
  const openId = Number(params.get("ticket")) || null;
  const [creating, setCreating] = useState(false);

  const listQs = new URLSearchParams({ status, size: String(size), page: String(page) });
  if (q.trim()) listQs.set("q", q.trim());
  if (akab) listQs.set("withAkab", "1");

  const options = useQuery({
    queryKey: ["portal", "delegate", "options"],
    queryFn: () => api.get<DelegateOptions>(`${DELEGATE_API}/options`),
    staleTime: 5 * 60_000,
  });
  const list = useQuery({
    queryKey: ["portal", "delegate", "tickets", listQs.toString()],
    queryFn: () => api.get<DelegateList>(`${DELEGATE_API}/tickets?${listQs.toString()}`),
    refetchInterval: 60_000,
    retry: (n, e) => !isNotSelfManaged(e) && n < 2,
  });

  if (list.isError && isNotSelfManaged(list.error)) {
    return (
      <div className="space-y-6">
        <PageHeader icon={Kanban} eyebrow={t("selfManaged.delegate.eyebrow")} title={t("selfManaged.delegate.title")} />
        <Pane className="p-10 text-center text-sm text-muted-foreground">{t("selfManaged.delegate.notSelfManaged")}</Pane>
      </div>
    );
  }

  const data = list.data;
  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Kanban}
        eyebrow={t("selfManaged.delegate.eyebrow")}
        title={t("selfManaged.delegate.title")}
        subtitle={t("selfManaged.delegate.subtitle")}
        actions={
          <Button type="button" onClick={() => setCreating(true)} className="gap-2">
            <Plus className="size-4" />
            {t("selfManaged.delegate.newTicket")}
          </Button>
        }
      />

      {/* Filters: state, AKAB, search */}
      <Pane className="flex flex-wrap items-center gap-2 p-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 border-0 bg-transparent pl-9 shadow-none focus-visible:ring-0 dark:bg-transparent"
            value={q}
            onChange={(e) => set({ q: e.target.value || null, page: null })}
            placeholder={t("selfManaged.delegate.search")}
            aria-label={t("selfManaged.delegate.search")}
          />
        </div>
        <Segmented
          id="delegate-status"
          value={status}
          options={TABS.map((f) => ({ value: f, label: t(`selfManaged.delegate.tabs.${f}`) }))}
          onChange={(v) => set({ status: v === "open" ? null : v, page: null })}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={akab}
          onClick={() => set({ akab: akab ? null : "1", page: null })}
          className={cn(
            "h-9 gap-2 rounded-xl border border-[color:var(--glass-border)] bg-background/30 hover:bg-foreground/[0.05]",
            akab && "border-[color:var(--gold)]/50 text-primary",
          )}
        >
          <span className={cn("size-2 rounded-full", akab ? "bg-[color:var(--gold)]" : "bg-muted-foreground/40")} />
          {t("selfManaged.delegate.akabOnly")}
        </Button>
      </Pane>

      {list.isLoading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="pane h-12 animate-pulse rounded-2xl" />
          ))}
        </div>
      )}
      {list.isError && !isNotSelfManaged(list.error) && <p className="text-sm text-destructive">{t("selfManaged.delegate.loadError")}</p>}

      {!list.isLoading && !list.isError && !items.length && (
        <Pane className="flex flex-col items-center gap-2 p-12 text-center text-sm text-muted-foreground">
          <Ticket className="size-6 text-primary/60" />
          {(data?.total ?? 0) === 0 && !q && status === "open" && !akab ? t("selfManaged.delegate.empty") : t("selfManaged.delegate.emptyFiltered")}
        </Pane>
      )}

      {items.length > 0 && (
        <Pane className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[320px] text-sm">
              <thead>
                <tr className="border-b border-[color:var(--glass-border)] text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  <th className="hidden px-4 py-2.5 font-semibold md:table-cell">{t("selfManaged.delegate.columns.number")}</th>
                  <th className="px-4 py-2.5 font-semibold">{t("selfManaged.delegate.columns.title")}</th>
                  <th className="px-4 py-2.5 font-semibold">{t("selfManaged.delegate.columns.status")}</th>
                  <th className="hidden px-4 py-2.5 font-semibold sm:table-cell">{t("selfManaged.delegate.columns.priority")}</th>
                  <th className="hidden px-4 py-2.5 font-semibold lg:table-cell">{t("selfManaged.delegate.columns.contact")}</th>
                  <th className="hidden px-4 py-2.5 font-semibold md:table-cell">{t("selfManaged.delegate.columns.due")}</th>
                  <th className="hidden px-4 py-2.5 font-semibold xl:table-cell">{t("selfManaged.delegate.columns.updated")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((x) => (
                  <tr
                    key={x.id}
                    onClick={() => set({ ticket: String(x.id) })}
                    className="cursor-pointer border-b border-[color:var(--glass-border)] transition-colors last:border-0 hover:bg-foreground/[0.03]"
                  >
                    <td className="hidden whitespace-nowrap px-4 py-3 font-mono text-xs text-muted-foreground md:table-cell">{x.number}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            set({ ticket: String(x.id) });
                          }}
                          className="max-w-[24ch] truncate text-left font-medium hover:text-primary sm:max-w-[40ch]"
                        >
                          {x.title}
                        </button>
                        {!x.withClient && (
                          <span className="inline-flex shrink-0 items-center rounded-full border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/12 px-2 py-0.5 text-[11px] font-semibold text-primary">
                            {t("selfManaged.delegate.badgeAkab")}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-muted-foreground md:hidden">{x.number}</div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={x.status} />
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      <PriorityBadge priority={x.priority} />
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground lg:table-cell">{x.contact ?? t("selfManaged.delegate.noDue")}</td>
                    <td className="hidden whitespace-nowrap px-4 py-3 md:table-cell">
                      <DueCell value={x.dueAt} complete={x.status.kind === "complete"} />
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-3 text-xs text-muted-foreground xl:table-cell">
                      {t("selfManaged.delegate.updatedAgo", { when: relativeTime(x.updatedAt) })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data && (
            <Pager
              total={data.total}
              page={data.page}
              size={size}
              onPage={(p) => set({ page: p > 1 ? String(p) : null })}
              onSize={(n) => set({ size: n === PAGE_SIZE ? null : String(n), page: null })}
            />
          )}
        </Pane>
      )}

      <NewTicketDialog
        open={creating}
        onOpenChange={setCreating}
        options={options.data}
        onCreated={(id) => {
          setCreating(false);
          void qc.invalidateQueries({ queryKey: ["portal", "delegate", "tickets"] });
          set({ ticket: String(id) });
        }}
        errorText={errorText}
      />

      <DelegateTicketDialog id={openId} options={options.data} onClose={() => set({ ticket: null })} />
    </div>
  );
}

/** New ticket of the company: title, description, priority, contact, due day. Its state lives in the form so each opening starts clean. */
function NewTicketDialog({
  open,
  onOpenChange,
  options,
  onCreated,
  errorText,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  options: DelegateOptions | undefined;
  onCreated: (id: number) => void;
  errorText: (e: unknown) => string;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{t("selfManaged.delegate.newDialog.title")}</DialogTitle>
        <DialogDescription>{t("selfManaged.delegate.newDialog.subtitle")}</DialogDescription>
        {open && <NewTicketForm options={options} onCreated={onCreated} errorText={errorText} />}
      </DialogContent>
    </Dialog>
  );
}

function NewTicketForm({ options, onCreated, errorText }: { options: DelegateOptions | undefined; onCreated: (id: number) => void; errorText: (e: unknown) => string }) {
  const { t } = useTranslation();
  const defaultPriority = options?.priorities.find((p) => p.kind === "medium")?.key ?? options?.priorities[0]?.key ?? "";
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("");
  const [contactId, setContactId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const chosenPriority = priority || defaultPriority;

  const create = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { title: title.trim(), description: description.trim() };
      if (chosenPriority) body.priority = chosenPriority;
      if (contactId) body.contactId = contactId;
      if (dueDate) body.dueDate = dueDate;
      return api.post<{ id: number; number: string | null }>(`${DELEGATE_API}/tickets`, body);
    },
    onSuccess: (r) => {
      toast.success(t("selfManaged.delegate.newDialog.created", { number: r.number ?? r.id }));
      onCreated(r.id);
    },
    onError: (e) => toast.error(errorText(e)),
  });

  const field = "h-9 w-full rounded-md border bg-transparent px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40";

  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() && !create.isPending) create.mutate();
      }}
    >
      <div className="space-y-1.5">
        <label htmlFor="delegate-new-title" className="text-sm font-medium">
          {t("selfManaged.delegate.newDialog.fieldTitle")}
        </label>
        <Input id="delegate-new-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus required />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="delegate-new-description" className="text-sm font-medium">
          {t("selfManaged.delegate.newDialog.fieldDescription")}
        </label>
        <Textarea id="delegate-new-description" value={description} maxLength={8000} rows={5} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <label htmlFor="delegate-new-priority" className="text-sm font-medium">
            {t("selfManaged.delegate.newDialog.fieldPriority")}
          </label>
          <select id="delegate-new-priority" value={chosenPriority} onChange={(e) => setPriority(e.target.value)} className={field}>
            {(options?.priorities ?? []).map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="delegate-new-contact" className="text-sm font-medium">
            {t("selfManaged.delegate.newDialog.fieldContact")}
          </label>
          <select id="delegate-new-contact" value={contactId} onChange={(e) => setContactId(e.target.value)} className={field}>
            <option value="">{t("selfManaged.delegate.newDialog.noContact")}</option>
            {(options?.contacts ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="delegate-new-due" className="text-sm font-medium">
            {t("selfManaged.delegate.newDialog.fieldDue")}
          </label>
          <input id="delegate-new-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={field} />
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={!title.trim() || create.isPending}>
          {t("selfManaged.delegate.newDialog.create")}
        </Button>
      </div>
    </form>
  );
}
