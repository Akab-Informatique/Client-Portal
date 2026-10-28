import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AnimatePresence, motion } from "motion/react";
import {
  Bookmark,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  Info,
  Loader2,
  MessageSquareReply,
  MessagesSquare,
  Paperclip,
  Search,
  Send,
  Siren,
  Ticket,
  Trash2,
  UploadCloud,
  User,
  UserCheck,
  Wrench,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useCan, useMe } from "@/lib/session";
import { api, ApiError } from "@/lib/api";
import { dateTime, relativeTime } from "@/lib/format";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { PageHeader, Pane, Segmented } from "./ui";

type Kind = "new" | "inProgress" | "needsAttention" | "waitingCustomer" | "waitingVendor" | "scheduled" | "complete" | "other";
type ClientTicket = {
  id: number;
  number: string;
  title: string;
  excerpt: string;
  statusKind: Kind;
  statusLabel: string | null;
  priorityKind: string;
  contact: string | null;
  mine: boolean;
  technician: string | null;
  createdAt: string;
  updatedAt: string;
};
type TicketDetail = Omit<ClientTicket, "excerpt"> & {
  description: string;
  dueAt: string;
  startDate: string | null;
  technicians: { name: string; primary: boolean; viewing: boolean }[];
  viewing: string[];
  attachments: { id: string; name: string; size: number; at: string; author: string }[];
  activity: { id: string; author: string; at: string; text: string; work: boolean }[];
};
type SupportContact = { phone: string | null; email: string | null };

type StatusFilter = "open" | "waiting" | "resolved" | "all";
const FILTERS: StatusFilter[] = ["open", "waiting", "resolved", "all"];

/** Status in the client's words, with its color (pill + dot). */
const STATUS: Record<Kind, { key: string; className: string; dot: string }> = {
  new: { key: "received", className: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300", dot: "bg-sky-400" },
  inProgress: { key: "inProgress", className: "border-[color:var(--gold)]/35 bg-[color:var(--gold)]/10 text-primary", dot: "bg-[color:var(--gold)]" },
  needsAttention: { key: "inProgress", className: "border-[color:var(--gold)]/35 bg-[color:var(--gold)]/10 text-primary", dot: "bg-[color:var(--gold)]" },
  scheduled: { key: "scheduled", className: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300", dot: "bg-violet-400" },
  waitingCustomer: { key: "waitingYou", className: "border-orange-500/40 bg-orange-500/12 text-orange-600 dark:text-orange-300", dot: "bg-orange-400" },
  waitingVendor: { key: "waitingVendor", className: "border-[color:var(--glass-border)] bg-foreground/[0.05] text-muted-foreground", dot: "bg-muted-foreground/60" },
  complete: { key: "resolved", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300", dot: "bg-emerald-400" },
  other: { key: "inProgress", className: "border-[color:var(--gold)]/35 bg-[color:var(--gold)]/10 text-primary", dot: "bg-[color:var(--gold)]" },
};
const firstName = (n: string | null) => (n ? n.split(" ")[0] : null);
const initialsOf = (n: string) =>
  n
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("");

function StatusPill({ kind }: { kind: Kind }) {
  const { t } = useTranslation();
  const s = STATUS[kind] ?? STATUS.other;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium backdrop-blur", s.className)}>
      <span className={cn("size-1.5 rounded-full", s.dot)} />
      {t(`client.tickets.status.${s.key}`)}
    </span>
  );
}

/** Client portal › Operations › Tickets. */
export function ClientTicketsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const set = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
        return p;
      },
      { replace: true },
    );
  const status = (FILTERS.includes(params.get("status") as StatusFilter) ? params.get("status") : "open") as StatusFilter;
  // mine (default) · company · some contacts of the company (only with "see all the company's tickets")
  const who = params.get("who");
  const whoIds = who ? who.split(",").filter(Boolean) : [];
  const scope = params.get("scope") === "company" ? "company" : whoIds.length ? "contact" : "mine";
  const q = params.get("q") ?? "";
  const openId = Number(params.get("t")) || null;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["portal", "tickets", scope, scope === "contact" ? whoIds.join(",") : null],
    queryFn: () =>
      api.get<{ linked: boolean; canSeeAll: boolean; contacts: { id: string; name: string }[]; items: ClientTicket[] }>(
        `/portal/tickets${scope === "company" ? "?scope=company" : scope === "contact" ? `?scope=contact&contact=${encodeURIComponent(whoIds.join(","))}` : ""}`,
      ),
    refetchInterval: 60_000,
  });
  const { data: contact } = useQuery({ queryKey: ["board", "contact"], queryFn: () => api.get<SupportContact>("/board/contact"), staleTime: 10 * 60_000 });
  const items = data?.items ?? [];

  const counts = useMemo(
    () => ({
      open: items.filter((x) => x.statusKind !== "complete").length,
      waiting: items.filter((x) => x.statusKind === "waitingCustomer").length,
      resolved: items.filter((x) => x.statusKind === "complete").length,
    }),
    [items],
  );
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((x) => {
      if (status === "open" && x.statusKind === "complete") return false;
      if (status === "waiting" && x.statusKind !== "waitingCustomer") return false;
      if (status === "resolved" && x.statusKind !== "complete") return false;
      return words.every((w) => `${x.number} ${x.title} ${x.excerpt} ${x.contact ?? ""}`.toLowerCase().includes(w));
    });
  }, [items, status, q]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Ticket}
        eyebrow={t("client.nav.operationsSection")}
        title={t("client.tickets.title")}
        subtitle={
          scope === "company"
            ? t("client.tickets.subtitleCompany")
            : scope === "contact"
              ? t("client.tickets.subtitleContacts", { names: whoIds.map((id) => data?.contacts.find((x) => x.id === id)?.name ?? "…").join(", ") })
              : t("client.tickets.subtitle")
        }
      />

      {data && !data.linked ? (
        <Pane className="p-10 text-center text-sm text-muted-foreground">{contact?.phone ? t("client.askNotLinkedPhone", { phone: contact.phone }) : t("client.askNotLinked")}</Pane>
      ) : (
        <>
          {/* What matters to the client, at a glance */}
          <div className="grid gap-3 sm:grid-cols-3">
            <Tile icon={Clock3} label={t("client.tickets.tiles.open")} value={counts.open} active={status === "open"} onClick={() => set({ status: null })} />
            <Tile
              icon={MessageSquareReply}
              label={t("client.tickets.tiles.waiting")}
              hint={counts.waiting ? t("client.tickets.tiles.waitingHint") : undefined}
              value={counts.waiting}
              alert={counts.waiting > 0}
              active={status === "waiting"}
              onClick={() => set({ status: "waiting" })}
            />
            <Tile icon={CheckCircle2} label={t("client.tickets.tiles.resolved")} value={counts.resolved} active={status === "resolved"} onClick={() => set({ status: "resolved" })} />
          </div>

          {/* Filter bar */}
          <Pane className="flex flex-wrap items-center gap-2 p-2">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-9 border-0 bg-transparent pl-9 shadow-none focus-visible:ring-0 dark:bg-transparent"
                value={q}
                onChange={(e) => set({ q: e.target.value || null })}
                placeholder={t("client.tickets.search")}
              />
            </div>
            <Segmented
              id="ticket-status"
              value={status}
              options={FILTERS.map((f) => ({ value: f, label: t(`client.tickets.filter.${f}`) }))}
              onChange={(v) => set({ status: v === "open" ? null : v })}
            />
            {data?.canSeeAll && (
              <WhoMenu
                scope={scope}
                whoIds={whoIds}
                contacts={data.contacts}
                // a saved filter starts again from the open tickets
                onChange={(next, fresh) =>
                  set({
                    scope: next.scope === "company" ? "company" : null,
                    who: next.scope === "contact" && next.who?.length ? next.who.join(",") : null,
                    ...(fresh ? { status: null } : {}),
                  })
                }
              />
            )}
          </Pane>

          {isLoading && (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="pane h-[5.5rem] animate-pulse rounded-2xl" />
              ))}
            </div>
          )}
          {isError && <p className="text-sm text-destructive">{t("common.error")}</p>}
          {!isLoading && !isError && !shown.length && (
            <Pane className="flex flex-col items-center gap-2 p-12 text-center text-sm text-muted-foreground">
              <Ticket className="size-6 text-primary/60" />
              {items.length ? t("client.tickets.emptyFiltered") : t("client.tickets.empty")}
            </Pane>
          )}

          <ul className="space-y-2.5">
            {shown.map((x, i) => (
              <motion.li key={x.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.03, 0.3) }}>
                <button
                  type="button"
                  onClick={() => set({ t: String(x.id) })}
                  className={cn(
                    "pane group flex w-full items-center gap-4 overflow-hidden rounded-2xl p-4 pl-5 text-left transition-all duration-300 hover:-translate-y-px hover:border-[color:var(--gold)]/35 hover:shadow-[0_18px_40px_-24px_var(--gold)]",
                    x.statusKind === "waitingCustomer" && "border-orange-500/30",
                  )}
                >
                  {/* status light on the left edge */}
                  <span className={cn("absolute inset-y-3 left-0 w-[3px] rounded-r-full opacity-80", (STATUS[x.statusKind] ?? STATUS.other).dot)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <h3 className="truncate text-[15px] font-semibold">{x.title}</h3>
                      <span className="font-mono text-[11px] text-muted-foreground/80">{x.number}</span>
                    </div>
                    {x.excerpt && <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{x.excerpt}</p>}
                    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {scope !== "mine" && x.contact && (
                        <span className="flex items-center gap-1.5">
                          <User className="size-3.5" /> {x.mine ? t("client.tickets.you") : x.contact}
                        </span>
                      )}
                      <span className="flex items-center gap-1.5">
                        <Wrench className="size-3.5" /> {x.technician ? t("client.tickets.handledBy", { name: firstName(x.technician) }) : t("client.tickets.notAssigned")}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Clock3 className="size-3.5" /> {t("client.tickets.updated", { when: relativeTime(x.updatedAt) })}
                      </span>
                    </p>
                  </div>
                  <StatusPill kind={x.statusKind} />
                  <ChevronRight className="hidden size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-primary sm:block" />
                </button>
              </motion.li>
            ))}
          </ul>
        </>
      )}

      <TicketOverlay id={openId} onClose={() => set({ t: null })} contact={contact ?? null} />
    </div>
  );
}

function Tile({ icon: Icon, label, value, hint, alert, active, onClick }: { icon: typeof Ticket; label: string; value: number; hint?: string; alert?: boolean; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "pane group flex items-center gap-4 overflow-hidden rounded-2xl p-4 text-left transition-all duration-300 hover:border-[color:var(--gold)]/35",
        active && "gold-edge border-[color:var(--gold)]/40 shadow-[0_20px_44px_-26px_var(--gold)]",
        alert && !active && "border-orange-500/35",
      )}
    >
      <span
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-xl border",
          alert ? "border-orange-500/30 bg-orange-500/12 text-orange-500" : "border-[color:var(--gold)]/25 bg-[color:var(--gold)]/10 text-primary",
        )}
      >
        <Icon className="size-5" />
      </span>
      <span className="min-w-0">
        <span className={cn("block font-display text-3xl font-bold leading-none", active && "text-grad-gold")}>{value}</span>
        <span className="mt-1.5 block text-sm text-muted-foreground">{label}</span>
        {hint && <span className="block text-xs text-orange-600 dark:text-orange-300">{hint}</span>}
      </span>
    </button>
  );
}

/**
 * Whose tickets: mine, the whole company, or the people of the company that
 * are ticked (several at once), and the filters saved with such a selection.
 * Only shown to whom has "see all the company's tickets".
 */
type SavedFilter = { id: string; name: string; contactIds: string[] };
type WhoChange = { scope: "mine" | "company" | "contact"; who?: string[] };

function WhoMenu({
  scope,
  whoIds,
  contacts,
  onChange,
}: {
  scope: "mine" | "company" | "contact";
  whoIds: string[];
  contacts: { id: string; name: string }[];
  onChange: (v: WhoChange, fresh?: boolean) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const { data: saved = [] } = useQuery({ queryKey: ["portal", "ticket-filters"], queryFn: () => api.get<SavedFilter[]>("/portal/ticket-filters") });
  const save = useMutation({
    mutationFn: () => api.post<SavedFilter>("/portal/ticket-filters", { name, contactIds: whoIds }),
    onSuccess: () => {
      toast.success(t("client.tickets.scope.savedOk"));
      setNaming(false);
      setName("");
      void qc.invalidateQueries({ queryKey: ["portal", "ticket-filters"] });
    },
    onError: () => toast.error(t("common.error")),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/portal/ticket-filters/${id}`),
    onSuccess: () => {
      toast.success(t("client.tickets.scope.removedOk"));
      void qc.invalidateQueries({ queryKey: ["portal", "ticket-filters"] });
    },
    onError: () => toast.error(t("common.error")),
  });

  const names = (ids: string[]) => ids.map((id) => contacts.find((x) => x.id === id)?.name ?? "…");
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const current = scope === "contact" ? saved.find((f) => same(f.contactIds, whoIds)) : undefined;
  const label =
    scope === "company"
      ? t("client.tickets.scope.company")
      : scope === "contact"
        ? (current?.name ?? (whoIds.length === 1 ? names(whoIds)[0] : t("client.tickets.scope.n", { count: whoIds.length })))
        : t("client.tickets.scope.mine");
  const shown = contacts.filter((x) => x.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const toggle = (id: string) => {
    const next = whoIds.includes(id) ? whoIds.filter((x) => x !== id) : [...whoIds, id];
    onChange(next.length ? { scope: "contact", who: next } : { scope: "mine" });
  };
  // keep the menu open while people are ticked
  const stay = (e: Event) => e.preventDefault();

  return (
    <>
      <DropdownMenu onOpenChange={(o) => !o && setFilter("")}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-9 gap-2 rounded-xl border border-[color:var(--glass-border)] bg-background/30 hover:bg-foreground/[0.05] data-[state=open]:border-[color:var(--gold)]/50"
          >
            {scope === "company" ? <Building2 className="size-4 text-primary" /> : scope === "contact" ? <User className="size-4 text-primary" /> : <UserCheck className="size-4 text-primary" />}
            <span className="max-w-44 truncate">{label}</span>
            <ChevronDown className="size-4 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="glass-strong w-80">
          {saved.length > 0 && (
            <>
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("client.tickets.scope.saved")}</DropdownMenuLabel>
              {saved.map((f) => (
                <DropdownMenuItem key={f.id} onSelect={() => onChange({ scope: "contact", who: f.contactIds }, true)} className={cn("gap-2", current?.id === f.id && "bg-[color:var(--gold)]/10")}>
                  <Bookmark className={cn("size-4", current?.id === f.id && "fill-current text-primary")} />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{t("client.tickets.scope.n", { count: f.contactIds.length })}</span>
                  <button
                    type="button"
                    aria-label={t("client.tickets.scope.remove")}
                    title={t("client.tickets.scope.remove")}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      remove.mutate(f.id);
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuCheckboxItem checked={scope === "mine"} onSelect={() => onChange({ scope: "mine" })}>
            <UserCheck className="size-4" /> {t("client.tickets.scope.mine")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={scope === "company"} onSelect={() => onChange({ scope: "company" })}>
            <Building2 className="size-4" /> {t("client.tickets.scope.company")}
          </DropdownMenuCheckboxItem>
          {contacts.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("client.tickets.scope.oneUser")}</DropdownMenuLabel>
              {contacts.length > 8 && (
                <div className="px-2 pb-1">
                  <Input className="h-8" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder={t("client.tickets.scope.findUser")} />
                </div>
              )}
              <div className="max-h-64 overflow-y-auto">
                {shown.map((x) => (
                  <DropdownMenuCheckboxItem
                    key={x.id}
                    checked={scope === "contact" && whoIds.includes(x.id)}
                    onSelect={(e) => {
                      stay(e);
                      toggle(x.id);
                    }}
                  >
                    <User className="size-4" /> <span className="truncate">{x.name}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </div>
              {scope === "contact" && (
                <>
                  <DropdownMenuSeparator />
                  {!current && (
                    <DropdownMenuItem onSelect={() => setNaming(true)}>
                      <Bookmark className="size-4" /> {t("client.tickets.scope.save")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => onChange({ scope: "mine" })}>
                    <X className="size-4" /> {t("client.tickets.scope.clear")}
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={naming} onOpenChange={setNaming}>
        <DialogContent className="max-w-md">
          <DialogTitle>{t("client.tickets.scope.saveTitle")}</DialogTitle>
          <DialogDescription>{t("client.tickets.scope.saveHint", { names: names(whoIds).join(", ") })}</DialogDescription>
          <form
            className="space-y-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (name.trim() && !save.isPending) save.mutate();
            }}
          >
            <Input autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("client.tickets.scope.name")} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setNaming(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!name.trim() || save.isPending}>
                {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("client.tickets.scope.saveDo")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * One ticket, full page from the centre. Tabs on top: the conversation (reply,
 * or ask for a priority escalation from the same box) and the documents.
 */
function TicketOverlay({ id, onClose, contact }: { id: number | null; onClose: () => void; contact: SupportContact | null }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const readOnly = Boolean(me.viewAs);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["portal", "ticket", id],
    queryFn: () => api.get<TicketDetail>(`/portal/tickets/${id}`),
    enabled: id != null,
    // new replies and "who has it open" stay current while it is open
    refetchInterval: 15_000,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["portal", "ticket", id] });
    void qc.invalidateQueries({ queryKey: ["portal", "tickets"] });
  };
  const errorText = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : "";
    if (code === "portal_already_escalated") return t("client.tickets.alreadyEscalated");
    if (code === "portal_ticket_closed") return t("client.tickets.closedNoEscalation");
    if (code === "rate_limited") return t("client.askTooMany");
    if (code === "read_only_view") return t("client.readOnlyView");
    return t("common.error");
  };

  const [tab, setTab] = useState<"conversation" | "documents">("conversation");
  const [text, setText] = useState("");
  const [escalating, setEscalating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setTab("conversation");
    setText("");
    setEscalating(false);
  }, [id]);
  useEffect(() => {
    if (tab === "conversation") endRef.current?.scrollIntoView({ block: "end" });
  }, [data?.activity.length, tab]);

  const comment = useMutation({
    mutationFn: () => api.post(`/portal/tickets/${id}/comments`, { text }),
    onSuccess: () => {
      setText("");
      toast.success(t("client.tickets.sent"));
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const escalate = useMutation({
    mutationFn: () => api.post(`/portal/tickets/${id}/escalate`, { reason: text }),
    onSuccess: () => {
      setText("");
      setEscalating(false);
      toast.success(t("client.tickets.escalated"));
      refresh();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) {
        if (f.size > MAX_FILE) throw new Error(t("client.tickets.fileTooBig", { name: f.name }));
        await api.post(`/portal/tickets/${id}/attachments`, { name: f.name, contentType: f.type || "application/octet-stream", data: await fileToBase64(f) });
      }
      return files.length;
    },
    onSuccess: (n) => {
      toast.success(t("client.tickets.filesSent", { count: n }));
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? errorText(e) : (e as Error).message),
  });

  const canComment = can("clientTickets.comment") && !readOnly;
  const canAttach = can("clientTickets.attach") && !readOnly;
  const canEscalate = can("clientTickets.escalate") && !readOnly && data?.statusKind !== "complete";
  const waiting = data?.statusKind === "waitingCustomer";
  const sending = comment.isPending || escalate.isPending;
  const ready = escalating ? text.trim().length >= 3 : Boolean(text.trim());
  const send = () => {
    if (!ready || sending) return;
    if (escalating) escalate.mutate();
    else comment.mutate();
  };

  return (
    <Dialog open={id != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-none flex-col gap-0 overflow-hidden rounded-3xl border-[color:var(--glass-border)] bg-background/90 p-0 dark:bg-background/70 shadow-[0_40px_120px_-40px_rgba(0,0,0,0.8)] backdrop-blur-2xl sm:max-w-none lg:h-[calc(100dvh-3rem)] lg:w-[calc(100vw-3rem)]"
      >
        <div className="client-ambient pointer-events-none absolute inset-0 -z-10 opacity-80" />
        {isLoading && (
          <div className="flex flex-1 items-center justify-center">
            <DialogTitle className="sr-only">{t("common.loading")}</DialogTitle>
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {isError && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <DialogTitle>{t("errors.notFound")}</DialogTitle>
            <Button variant="outline" onClick={onClose}>
              {t("common.close")}
            </Button>
          </div>
        )}
        {data && (
          <>
            {/* Header: number, title, status, who is on it — then the tabs */}
            <header className="relative border-b border-[color:var(--glass-border)] px-5 pt-5 sm:px-8">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[11px] tracking-wide text-muted-foreground">{data.number}</p>
                  <DialogTitle className="mt-1 text-xl leading-snug sm:text-[1.65rem]">{data.title}</DialogTitle>
                  <DialogDescription className="sr-only">{data.title}</DialogDescription>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <StatusPill kind={data.statusKind} />
                    {data.viewing.length > 0 && (
                      <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600 backdrop-blur dark:text-emerald-300">
                        <span className="relative flex size-2">
                          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                        </span>
                        {t("client.tickets.viewingNow", { names: data.viewing.join(", "), count: data.viewing.length })}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="pane flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={t("common.close")}
                >
                  <X className="size-4" />
                </button>
              </div>
              <nav className="mt-4 flex gap-1" role="tablist">
                {(
                  [
                    { key: "conversation", icon: MessagesSquare, label: t("client.tickets.tabConversation"), count: data.activity.length || null },
                    { key: "documents", icon: Paperclip, label: t("client.tickets.documents"), count: data.attachments.length || null },
                  ] as const
                ).map((x) => (
                  <button
                    key={x.key}
                    type="button"
                    role="tab"
                    aria-selected={tab === x.key}
                    onClick={() => setTab(x.key)}
                    className={cn("relative flex items-center gap-2 px-3.5 pb-3 pt-1.5 text-sm font-medium transition-colors", tab === x.key ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    <x.icon className={cn("size-4", tab === x.key && "text-primary")} />
                    {x.label}
                    {x.count != null && <span className="rounded-full bg-foreground/[0.07] px-1.5 text-[11px] tabular-nums text-muted-foreground">{x.count}</span>}
                    {tab === x.key && (
                      <motion.span layoutId="ticket-tab" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-grad-gold shadow-[0_0_12px_var(--gold)]" transition={{ type: "spring", bounce: 0.15, duration: 0.35 }} />
                    )}
                  </button>
                ))}
              </nav>
            </header>

            <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_340px]">
              <section className="flex min-h-0 flex-col">
                {tab === "conversation" ? (
                  <>
                    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-6 sm:px-8 scrollbar-thin">
                      {data.description && (
                        <Bubble mine person={data.contact ?? me.name} author={data.mine ? t("client.tickets.you") : (data.contact ?? "—")} at={data.createdAt} label={t("client.tickets.request")}>
                          {data.description}
                        </Bubble>
                      )}
                      {data.activity.map((n) => {
                        const mine = n.author === me.name;
                        return (
                          <Bubble key={n.id} mine={mine} person={n.author} author={mine ? t("client.tickets.you") : n.author} at={n.at} label={n.work ? t("client.tickets.work") : undefined}>
                            {n.text}
                          </Bubble>
                        );
                      })}
                      {!data.activity.length && <p className="text-center text-sm text-muted-foreground">{t("client.tickets.noExchanges")}</p>}
                      <div ref={endRef} />
                    </div>

                    {/* Reply — or, switched on, a priority escalation request */}
                    {canComment ? (
                      <form
                        className="px-4 pb-4 sm:px-8 sm:pb-6"
                        onSubmit={(e: FormEvent) => {
                          e.preventDefault();
                          send();
                        }}
                      >
                        {waiting && !escalating && (
                          <p className="mb-2 flex items-center gap-2 text-sm font-medium text-orange-600 dark:text-orange-300">
                            <MessageSquareReply className="size-4" /> {t("client.tickets.waitingNote")}
                          </p>
                        )}
                        <div
                          className={cn(
                            "pane rounded-2xl transition-colors focus-within:border-[color:var(--gold)]/45",
                            escalating && "border-orange-500/45 focus-within:border-orange-500/60",
                            waiting && !escalating && "border-orange-500/30",
                          )}
                        >
                          <AnimatePresence initial={false}>
                            {escalating && (
                              <motion.p
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                className="flex items-start gap-2 overflow-hidden border-b border-orange-500/20 px-4 py-2.5 text-xs text-orange-700 dark:text-orange-200"
                              >
                                <Siren className="mt-px size-3.5 shrink-0" />
                                <span>
                                  {t("client.tickets.escalateModeHint")} {contact?.phone ? t("client.tickets.urgentPhone", { phone: contact.phone }) : t("client.tickets.urgent")}
                                </span>
                              </motion.p>
                            )}
                          </AnimatePresence>
                          <Textarea
                            rows={3}
                            maxLength={escalating ? 2000 : 6000}
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
                            }}
                            placeholder={escalating ? t("client.tickets.escalateReason") : waiting ? t("client.tickets.answerPlaceholder") : t("client.tickets.replyPlaceholder")}
                            className="resize-none border-0 bg-transparent px-4 pt-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
                          />
                          <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
                            {canEscalate && (
                              <button
                                type="button"
                                aria-pressed={escalating}
                                onClick={() => setEscalating((v) => !v)}
                                className={cn(
                                  "flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                                  escalating
                                    ? "border-orange-500/50 bg-orange-500/15 text-orange-600 dark:text-orange-300"
                                    : "border-[color:var(--glass-border)] text-muted-foreground hover:border-orange-500/40 hover:text-orange-600 dark:hover:text-orange-300",
                                )}
                              >
                                <Siren className="size-3.5" /> {t("client.tickets.escalate")}
                              </button>
                            )}
                            <span className="hidden text-xs text-muted-foreground/80 sm:inline">{t("client.tickets.ctrlEnter")}</span>
                            <Button
                              type="submit"
                              disabled={sending || !ready}
                              className={cn("ml-auto rounded-xl font-semibold", escalating ? "bg-orange-500 text-white hover:bg-orange-600" : "bg-grad-gold text-[#1a1204] glow-gold hover:brightness-105")}
                            >
                              {sending ? <Loader2 className="size-4 animate-spin" /> : escalating ? <Siren className="size-4" /> : <Send className="size-4" />}{" "}
                              {escalating ? t("client.tickets.escalateSend") : t("client.tickets.send")}
                            </Button>
                          </div>
                        </div>
                      </form>
                    ) : (
                      <p className="border-t border-[color:var(--glass-border)] px-5 py-3 text-xs text-muted-foreground sm:px-8">
                        {readOnly ? t("client.readOnlyView") : contact?.phone ? t("client.tickets.addInfoPhone", { phone: contact.phone }) : t("client.tickets.addInfo")}
                      </p>
                    )}
                  </>
                ) : (
                  /* Documents: drop zone on top, then the files */
                  <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-6 sm:px-8 scrollbar-thin">
                    {canAttach && (
                      <button
                        type="button"
                        disabled={upload.isPending}
                        onClick={() => fileInput.current?.click()}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDragging(true);
                        }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDragging(false);
                          if (e.dataTransfer.files.length) upload.mutate(Array.from(e.dataTransfer.files));
                        }}
                        className={cn(
                          "flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed border-[color:var(--gold)]/30 bg-[color:var(--glass-bg)] px-6 py-10 text-center backdrop-blur-xl transition-all",
                          dragging ? "border-[color:var(--gold)] bg-[color:var(--gold)]/10 shadow-[0_0_40px_-12px_var(--gold)]" : "hover:border-[color:var(--gold)]/45",
                        )}
                      >
                        <span className="flex size-12 items-center justify-center rounded-2xl border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/10 text-primary">
                          {upload.isPending ? <Loader2 className="size-5 animate-spin" /> : <UploadCloud className="size-5" />}
                        </span>
                        <span className="text-sm font-medium">{t("client.tickets.dropTitle")}</span>
                        <span className="text-xs text-muted-foreground">{t("client.tickets.dropHint")}</span>
                      </button>
                    )}
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      hidden
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        e.target.value = "";
                        if (files.length) upload.mutate(files);
                      }}
                    />
                    {data.attachments.length ? (
                      <ul className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                        {data.attachments.map((f) => (
                          <li key={f.id} className="pane flex items-center gap-3 rounded-xl p-3">
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.05] text-primary">
                              <FileText className="size-5" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{f.name}</span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {[fileSize(f.size), f.author, relativeTime(f.at)].filter(Boolean).join(" · ")}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="py-6 text-center text-sm text-muted-foreground">{t("client.tickets.noDocuments")}</p>
                    )}
                  </div>
                )}
              </section>

              {/* Side: technicians and details */}
              <aside className="min-h-0 space-y-4 overflow-y-auto border-t border-[color:var(--glass-border)] p-5 lg:border-l lg:border-t-0 scrollbar-thin">
                {/* Technicians: assigned, then secondary; green dot = on the ticket right now */}
                <Pane className="p-4">
                  <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    <Wrench className="size-3.5 text-primary" /> {t("client.tickets.technicians")}
                  </h3>
                  {data.technicians.length ? (
                    <ul className="mt-3.5 space-y-3">
                      {data.technicians.map((p) => (
                        <li key={p.name} className="flex items-center gap-3">
                          <span
                            className={cn(
                              "relative flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                              p.primary ? "bg-grad-gold text-[#1a1204]" : "border border-[color:var(--gold)]/35 bg-[color:var(--gold)]/10 text-primary",
                            )}
                          >
                            {initialsOf(p.name)}
                            {p.viewing && (
                              <span className="absolute -bottom-0.5 -right-0.5 flex size-3" title={t("client.tickets.onTicket")}>
                                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                                <span className="relative inline-flex size-3 rounded-full border-2 border-background bg-emerald-500" />
                              </span>
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5 text-sm font-medium">
                              <span className="truncate">{p.name}</span>
                              {p.viewing && <span className="size-2 shrink-0 rounded-full bg-emerald-500" aria-label={t("client.tickets.onTicket")} />}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {p.primary ? t("client.tickets.assigned") : t("client.tickets.secondary")}
                              {p.viewing && <span className="text-emerald-600 dark:text-emerald-400"> · {t("client.tickets.onTicket")}</span>}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">{t("client.tickets.notAssigned")}</p>
                  )}
                </Pane>

                {/* Ticket details */}
                <Pane className="p-4">
                  <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    <Info className="size-3.5 text-primary" /> {t("client.tickets.details")}
                  </h3>
                  <dl className="mt-3.5 divide-y divide-[color:var(--glass-border)] text-sm">
                    <div className="flex items-center justify-between gap-3 pb-2.5">
                      <dt className="text-muted-foreground">{t("client.tickets.statusLabel")}</dt>
                      <dd>
                        <StatusPill kind={data.statusKind} />
                      </dd>
                    </div>
                    <Row label={t("client.tickets.startDate")} value={data.startDate ? longDay(data.startDate) : t("client.tickets.notPlanned")} muted={!data.startDate} />
                    <Row
                      label={t("client.tickets.dueDate")}
                      value={data.dueAt ? dateTime(data.dueAt) : "—"}
                      alert={Boolean(data.dueAt) && data.statusKind !== "complete" && Date.parse(data.dueAt) < Date.now()}
                    />
                    <Row label={t("client.tickets.requester")} value={data.mine ? t("client.tickets.you") : (data.contact ?? "—")} />
                    <Row label={t("client.tickets.opened")} value={dateTime(data.createdAt)} />
                    <Row label={t("client.tickets.lastUpdate")} value={relativeTime(data.updatedAt)} />
                  </dl>
                </Pane>
              </aside>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const MAX_FILE = 5 * 1024 * 1024;

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

function fileSize(n: number): string {
  if (!n) return "";
  const [b, kb, mb] = currentLocale() === "en" ? ["B", "KB", "MB"] : ["o", "Ko", "Mo"];
  if (n < 1024) return `${n} ${b}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} ${kb}`;
  return `${(n / 1024 / 1024).toFixed(1)} ${mb}`;
}

/** One message of the conversation: the client on the right (gold glass), AKAB on the left. */
function Bubble({ mine, person, author, at, label, children }: { mine: boolean; person: string; author: string; at: string; label?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-end gap-2.5", mine ? "flex-row-reverse" : "flex-row")}>
      <span
        className={cn(
          "mb-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
          mine ? "border border-[color:var(--gold)]/35 bg-[color:var(--gold)]/12 text-primary" : "bg-foreground/[0.08] text-muted-foreground",
        )}
      >
        {initialsOf(person)}
      </span>
      <div className={cn("max-w-[min(42rem,85%)]", mine && "text-right")}>
        <p className="mb-1 px-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/90">{author}</span> · {dateTime(at)}
          {label && <span className="ml-1.5 rounded-full border border-[color:var(--glass-border)] px-1.5 py-px text-[10px] uppercase tracking-wide">{label}</span>}
        </p>
        <div
          className={cn(
            "whitespace-pre-wrap rounded-2xl border px-4 py-3 text-left text-sm leading-relaxed backdrop-blur-xl",
            mine
              ? "rounded-br-md border-[color:var(--gold)]/30 bg-gradient-to-br from-[color:var(--gold)]/16 to-[color:var(--gold)]/[0.05]"
              : "rounded-bl-md border-[color:var(--glass-border)] bg-[color:var(--glass-bg)] shadow-[inset_0_1px_0_0_var(--glass-highlight)]",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, alert, muted }: { label: string; value: string; alert?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5 last:pb-0">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("text-right", alert && "font-medium text-destructive", muted && "text-muted-foreground")}>{value}</dd>
    </div>
  );
}

/** A portal start date (YYYY-MM-DD) as a readable day. */
function longDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(currentLocale() === "en" ? "en-CA" : "fr-CA", { weekday: "short", day: "numeric", month: "long", year: "numeric" });
}
