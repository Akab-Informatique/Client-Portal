import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText, Loader2, LifeBuoy, Paperclip, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { dateTime, relativeTime } from "@/lib/format";
import { useDraft } from "@/lib/useDraft";
import { cn } from "@/lib/utils";
import { Pane, Segmented } from "./ui";
import {
  DELEGATE_API,
  MAX_FILE_BYTES,
  dayOf,
  fileToBase64,
  sizeOf,
  useDelegateError,
  type DelegateActivity,
  type DelegateOptions,
  type DelegateTicket,
} from "./delegateShared";

type ComposeTab = "reply" | "note";

/** The ticket window of the delegate: a big dialog opened from the list or from `?ticket=<id>`. */
export function DelegateTicketDialog({ id, options, onClose }: { id: number | null; options: DelegateOptions | undefined; onClose: () => void }) {
  return (
    <Dialog open={id != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-none flex-col gap-0 overflow-hidden rounded-3xl border-[color:var(--glass-border)] bg-background/90 p-0 dark:bg-background/70 shadow-[0_40px_120px_-40px_rgba(0,0,0,0.8)] backdrop-blur-2xl sm:max-w-none lg:h-[calc(100dvh-3rem)] lg:w-[calc(100vw-3rem)]"
      >
        <div className="client-ambient pointer-events-none absolute inset-0 -z-10 opacity-80" />
        {id != null && <TicketContent id={id} options={options} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function TicketContent({ id, options, onClose }: { id: number; options: DelegateOptions | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errorText = useDelegateError();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["portal", "delegate", "ticket", id],
    queryFn: () => api.get<DelegateTicket>(`${DELEGATE_API}/tickets/${id}`),
    refetchInterval: 30_000,
  });

  /** Everything that changes the ticket or its activity: this ticket and the lists */
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["portal", "delegate", "ticket", id] });
    void qc.invalidateQueries({ queryKey: ["portal", "delegate", "tickets"] });
  };

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<{ ok: boolean }>(`${DELEGATE_API}/tickets/${id}`, body),
    onSuccess: refresh,
    onError: (e) => {
      toast.error(errorText(e));
      refresh();
    },
  });

  return (
    <>
      {isLoading && (
        <div className="flex flex-1 items-center justify-center">
          <DialogTitle className="sr-only">{t("common.loading")}</DialogTitle>
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}
      {isError && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
          <DialogTitle className="sr-only">{t("selfManaged.delegate.ticket.loadError")}</DialogTitle>
          <p className="text-sm text-destructive">{t("selfManaged.delegate.ticket.loadError")}</p>
          <Button variant="outline" onClick={onClose}>
            {t("selfManaged.delegate.ticket.close")}
          </Button>
        </div>
      )}
      {data && (
        <Loaded ticket={data} options={options} onClose={onClose} save={save} refresh={refresh} errorText={errorText} />
      )}
    </>
  );
}

type LoadedProps = {
  ticket: DelegateTicket;
  options: DelegateOptions | undefined;
  onClose: () => void;
  save: UseMutationResult<{ ok: boolean }, unknown, Record<string, unknown>>;
  refresh: () => void;
  errorText: (e: unknown) => string;
};

function Loaded({ ticket: x, options, onClose, save, refresh, errorText }: LoadedProps) {
  const { t } = useTranslation();
  const readOnly = x.withAkab;
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <>
      <DialogTitle className="sr-only">{`${x.number} ${x.title}`}</DialogTitle>
      <DialogDescription className="sr-only">{x.status.label}</DialogDescription>

      {/* Header: number, title (edited in place when with the client), close */}
      <header className="flex shrink-0 items-center gap-3 border-b border-[color:var(--glass-border)] px-5 py-3.5">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{x.number}</span>
        <div className="min-w-0 flex-1">
          <TitleField ticket={x} readOnly={readOnly} onSave={(title) => save.mutate({ title })} />
        </div>
        {readOnly && (
          <span className="hidden shrink-0 items-center rounded-full border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/12 px-2.5 py-0.5 text-xs font-semibold text-primary sm:inline-flex">
            {t("selfManaged.delegate.badgeAkab")}
          </span>
        )}
        <Button variant="ghost" size="icon" className="size-9 shrink-0" onClick={onClose} aria-label={t("selfManaged.delegate.ticket.close")} title={t("selfManaged.delegate.ticket.close")}>
          <X className="size-4" />
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Main: read only banner, description, conversation, composer */}
        <section className="min-h-0 space-y-5 overflow-y-auto p-5 scrollbar-thin">
          {readOnly && (
            <Pane className="border-[color:var(--gold)]/40 bg-[color:var(--gold)]/[0.07] p-4 text-sm">{t("selfManaged.delegate.ticket.readOnlyBanner")}</Pane>
          )}

          <Description ticket={x} readOnly={readOnly} onSave={(description) => save.mutate({ description })} />

          <Conversation activity={x.activity} />

          {!readOnly && <Composer id={x.id} onSent={refresh} errorText={errorText} />}
        </section>

        {/* Side: fields, help, files */}
        <aside className="min-h-0 space-y-4 overflow-y-auto border-t border-[color:var(--glass-border)] p-5 lg:border-l lg:border-t-0 scrollbar-thin">
          <Pane className="space-y-4 p-4">
            <SelectField
              id="delegate-status"
              label={t("selfManaged.delegate.ticket.fieldStatus")}
              value={x.status.key}
              disabled={readOnly}
              options={withCurrent(options?.statuses ?? [], x.status).map((s) => ({ value: s.key, label: s.label }))}
              onChange={(v) => save.mutate({ status: v })}
            />
            <SelectField
              id="delegate-priority"
              label={t("selfManaged.delegate.ticket.fieldPriority")}
              value={x.priority.key}
              disabled={readOnly}
              options={withCurrent(options?.priorities ?? [], x.priority).map((p) => ({ value: p.key, label: p.label }))}
              onChange={(v) => save.mutate({ priority: v })}
            />
            <SelectField
              id="delegate-contact"
              label={t("selfManaged.delegate.ticket.fieldContact")}
              value={x.contactId ?? ""}
              disabled={readOnly}
              options={[{ value: "", label: t("selfManaged.delegate.newDialog.noContact") }, ...(options?.contacts ?? []).map((c) => ({ value: c.id, label: c.name }))]}
              onChange={(v) => save.mutate({ contactId: v || null })}
            />
            <div className="space-y-1.5">
              <label htmlFor="delegate-due" className="text-sm font-medium">
                {t("selfManaged.delegate.ticket.fieldDue")}
              </label>
              <Input
                id="delegate-due"
                type="date"
                value={dayOf(x.dueAt)}
                disabled={readOnly}
                onChange={(e) => {
                  if (e.target.value) save.mutate({ dueDate: e.target.value });
                }}
                className="h-9"
              />
            </div>
            <dl className="space-y-1 pt-1 text-xs text-muted-foreground">
              <div className="flex justify-between gap-3">
                <dt>{t("selfManaged.delegate.columns.updated")}</dt>
                <dd>{relativeTime(x.updatedAt)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>{t("selfManaged.delegate.ticket.created")}</dt>
                <dd>{dateTime(x.createdAt)}</dd>
              </div>
            </dl>
          </Pane>

          {!readOnly && (
            <Button type="button" className="w-full gap-2" variant="outline" onClick={() => setHelpOpen(true)}>
              <LifeBuoy className="size-4 text-primary" />
              {t("selfManaged.delegate.ticket.help.button")}
            </Button>
          )}

          <Attachments ticketId={x.id} files={x.attachments} readOnly={readOnly} onAdded={refresh} errorText={errorText} />
        </aside>
      </div>

      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} ticketId={x.id} onDone={refresh} errorText={errorText} />
    </>
  );
}

/** The current value stays in the list even when the portal no longer offers it */
function withCurrent<T extends { key: string }>(list: T[], current: T): T[] {
  return list.some((o) => o.key === current.key) ? list : [...list, current];
}

/** Title: a button that becomes a field when the ticket is with the client; Enter or leaving saves, Escape cancels */
function TitleField({ ticket: x, readOnly, onSave }: { ticket: DelegateTicket; readOnly: boolean; onSave: (title: string) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(x.title);
  useEffect(() => {
    if (!editing) setDraft(x.title);
  }, [x.title, editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== x.title) onSave(next);
    else setDraft(x.title);
  };

  if (editing && !readOnly) {
    return (
      <Input
        autoFocus
        value={draft}
        maxLength={200}
        aria-label={t("selfManaged.delegate.ticket.fieldTitleEdit")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(x.title);
            setEditing(false);
          }
        }}
        className="h-9 text-base font-semibold"
      />
    );
  }
  if (readOnly) return <h2 className="truncate text-lg font-semibold">{x.title}</h2>;
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={t("selfManaged.delegate.ticket.fieldTitleEdit")}
      aria-label={t("selfManaged.delegate.ticket.fieldTitleEdit")}
      className="block max-w-full truncate rounded-md text-left text-lg font-semibold hover:text-primary"
    >
      {x.title}
    </button>
  );
}

/** The description, saved when the field is left */
function Description({ ticket: x, readOnly, onSave }: { ticket: DelegateTicket; readOnly: boolean; onSave: (description: string) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(x.description);
  useEffect(() => setValue(x.description), [x.description]);
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("selfManaged.delegate.ticket.description")}</h3>
      {readOnly ? (
        <p className="whitespace-pre-wrap text-sm">{x.description || t("selfManaged.delegate.ticket.descriptionEmpty")}</p>
      ) : (
        <Textarea
          value={value}
          rows={5}
          maxLength={8000}
          placeholder={t("selfManaged.delegate.ticket.descriptionPlaceholder")}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            if (value !== x.description) onSave(value);
          }}
          aria-label={t("selfManaged.delegate.ticket.description")}
        />
      )}
    </div>
  );
}

function SelectField({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border bg-transparent px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The conversation, newest first: what was said to the client (the client's
 * own people on the left, AKAB on the right in gold) and the delegates' internal
 * notes in violet.
 */
function Conversation({ activity }: { activity: DelegateActivity[] }) {
  const { t } = useTranslation();
  const items = [...activity].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("selfManaged.delegate.ticket.activity")}</h3>
      {!items.length && <p className="py-6 text-center text-sm text-muted-foreground">{t("selfManaged.delegate.ticket.activityEmpty")}</p>}
      <ul className="space-y-3">
        {items.map((a) => {
          if (a.internal) {
            return (
              <li key={a.id} className="rounded-2xl border border-violet-500/30 bg-violet-500/10 p-3.5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-violet-600 dark:text-violet-300">
                  {t("selfManaged.delegate.ticket.internalLabel")} · {a.author} · {dateTime(a.at)}
                </p>
                <p className="mt-1.5 whitespace-pre-wrap text-sm">{a.text}</p>
              </li>
            );
          }
          // AKAB's replies: the portal writes them as "AKAB" and they are not a delegate's words
          const fromAkab = !a.byDelegate && a.author === "AKAB";
          return (
            <li key={a.id} className={cn("flex", fromAkab ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-2xl border p-3.5 sm:max-w-[70%]",
                  fromAkab ? "border-[color:var(--gold)]/35 bg-[color:var(--gold)]/12 rounded-br-md" : "border-[color:var(--glass-border)] bg-background/40 rounded-bl-md",
                )}
              >
                <p className={cn("text-xs font-semibold", fromAkab ? "text-primary" : "text-muted-foreground")}>
                  {fromAkab ? t("selfManaged.delegate.ticket.akab") : a.author} · {dateTime(a.at)}
                </p>
                <p className="mt-1.5 whitespace-pre-wrap text-sm">{a.text}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Reply to the client or internal note, Ctrl+Enter sends. Each tab keeps its own draft on this computer. */
function Composer({ id, onSent, errorText }: { id: number; onSent: () => void; errorText: (e: unknown) => string }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ComposeTab>("reply");
  const [reply, setReply, clearReply] = useDraft(`delegate-ticket:${id}:reply`);
  const [note, setNote, clearNote] = useDraft(`delegate-ticket:${id}:note`);
  const text = tab === "reply" ? reply : note;
  const setText = tab === "reply" ? setReply : setNote;
  const trimmed = text.trim();

  const send = useMutation({
    mutationFn: (kind: ComposeTab) => api.post<{ ok: boolean }>(`${DELEGATE_API}/tickets/${id}/notes`, { text: trimmed, kind }),
    onSuccess: (_r, kind) => {
      if (kind === "reply") clearReply();
      else clearNote();
      toast.success(t("selfManaged.delegate.ticket.compose.sent"));
      onSent();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const sendNow = () => {
    if (trimmed && !send.isPending) send.mutate(tab);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      sendNow();
    }
  };

  return (
    <Pane className="space-y-3 p-4">
      <Segmented
        id={`delegate-compose-${id}`}
        value={tab}
        options={[
          { value: "reply", label: t("selfManaged.delegate.ticket.compose.reply") },
          { value: "note", label: t("selfManaged.delegate.ticket.compose.note") },
        ]}
        onChange={(v) => setTab(v)}
      />
      <p className="text-xs text-muted-foreground">{tab === "reply" ? t("selfManaged.delegate.ticket.compose.replyHint") : t("selfManaged.delegate.ticket.compose.noteHint")}</p>
      <Textarea
        value={text}
        rows={4}
        maxLength={4000}
        placeholder={t("selfManaged.delegate.ticket.compose.placeholder")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        aria-label={tab === "reply" ? t("selfManaged.delegate.ticket.compose.reply") : t("selfManaged.delegate.ticket.compose.note")}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{t("selfManaged.delegate.ticket.compose.sendHint")}</span>
        <Button type="button" onClick={sendNow} disabled={!trimmed || send.isPending}>
          {send.isPending ? t("selfManaged.delegate.ticket.compose.sending") : t("selfManaged.delegate.ticket.compose.send")}
        </Button>
      </div>
    </Pane>
  );
}

/** Files of the ticket: download links, add by button or drag and drop (5 MB each, base64) */
function Attachments({
  ticketId,
  files,
  readOnly,
  onAdded,
  errorText,
}: {
  ticketId: number;
  files: DelegateTicket["attachments"];
  readOnly: boolean;
  onAdded: () => void;
  errorText: (e: unknown) => string;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const upload = async (list: File[]) => {
    setBusy(true);
    try {
      for (const file of list) {
        if (file.size > MAX_FILE_BYTES) {
          toast.error(t("selfManaged.delegate.errors.file_too_big"));
          continue;
        }
        const data = await fileToBase64(file);
        await api.post(`${DELEGATE_API}/tickets/${ticketId}/attachments`, {
          name: file.name.slice(0, 200),
          contentType: file.type || "application/octet-stream",
          data,
        });
        toast.success(t("selfManaged.delegate.ticket.fileAdded"));
      }
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
      onAdded();
    }
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (list.length) void upload(list);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const list = Array.from(e.dataTransfer.files);
    if (list.length && !readOnly) void upload(list);
  };

  return (
    <Pane className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Paperclip className="size-3.5 text-primary" /> {t("selfManaged.delegate.ticket.attachments")}
        </h3>
        {!readOnly && (
          <Button type="button" size="sm" variant="outline" className="h-8 gap-2" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <UploadCloud className="size-3.5" />}
            {busy ? t("selfManaged.delegate.ticket.uploading") : t("selfManaged.delegate.ticket.upload")}
          </Button>
        )}
      </div>
      {!readOnly && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn("rounded-xl border border-dashed p-3 text-center text-xs text-muted-foreground transition-colors", dragging && "border-[color:var(--gold)] text-primary")}
        >
          {t("selfManaged.delegate.ticket.dropHint")}
        </div>
      )}
      <input ref={input} type="file" multiple hidden onChange={onPick} aria-label={t("selfManaged.delegate.ticket.upload")} />
      {files.length ? (
        <ul className="space-y-2">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 rounded-xl border border-[color:var(--glass-border)] p-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] text-primary">
                <FileText className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{f.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{[sizeOf(f.size), dateTime(f.at)].join(" · ")}</span>
              </span>
              <a
                href={`/api${DELEGATE_API}/tickets/${ticketId}/files/${f.id}`}
                className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-[color:var(--gold)]/10"
              >
                {t("selfManaged.delegate.ticket.download")}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-center text-xs text-muted-foreground">{t("selfManaged.delegate.ticket.attachmentsEmpty")}</p>
      )}
    </Pane>
  );
}

/** Ask AKAB for help: explains that AKAB takes the ticket, with an optional message */
function HelpDialog({
  open,
  onOpenChange,
  ticketId,
  onDone,
  errorText,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ticketId: number;
  onDone: () => void;
  errorText: (e: unknown) => string;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle>{t("selfManaged.delegate.ticket.help.title")}</DialogTitle>
        <DialogDescription>{t("selfManaged.delegate.ticket.help.body")}</DialogDescription>
        {open && <HelpForm ticketId={ticketId} onDone={() => { onOpenChange(false); onDone(); }} errorText={errorText} />}
      </DialogContent>
    </Dialog>
  );
}

function HelpForm({ ticketId, onDone, errorText }: { ticketId: number; onDone: () => void; errorText: (e: unknown) => string }) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const ask = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>(`${DELEGATE_API}/tickets/${ticketId}/help`, message.trim() ? { message: message.trim() } : {}),
    onSuccess: () => {
      toast.success(t("selfManaged.delegate.ticket.help.done"));
      onDone();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ask.isPending) ask.mutate();
      }}
    >
      <div className="space-y-1.5">
        <label htmlFor="delegate-help-message" className="text-sm font-medium">
          {t("selfManaged.delegate.ticket.help.message")}
        </label>
        <Textarea id="delegate-help-message" value={message} rows={4} maxLength={1000} onChange={(e) => setMessage(e.target.value)} />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={ask.isPending} className="gap-2">
          {ask.isPending && <Loader2 className="size-4 animate-spin" />}
          {t("selfManaged.delegate.ticket.help.confirm")}
        </Button>
      </div>
    </form>
  );
}
