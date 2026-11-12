import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { dateTime, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Pane } from "./ui";
import { DELEGATE_API, StatusBadge, type DelegateContact, type DelegateList, type DelegateRef, type DelegateTicket } from "./delegateShared";

/** A value list that still holds the current value when the portal no longer offers it */
export function withCurrent<T extends { key: string }>(list: T[], current: T): T[] {
  return list.some((o) => o.key === current.key) ? list : [...list, current];
}

/** Title: a button that becomes a field; Enter or leaving saves, Escape cancels */
export function TitleField({ ticket: x, onSave }: { ticket: DelegateTicket; onSave: (title: string) => void }) {
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

  if (editing) {
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
export function Description({ ticket: x, onSave }: { ticket: DelegateTicket; onSave: (description: string) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(x.description);
  useEffect(() => setValue(x.description), [x.description]);
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("selfManaged.delegate.ticket.description")}</h3>
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
    </div>
  );
}

/** A status / priority chip that is also its select. It keeps the picked value until the server answers; on an error the parent remounts it. */
export function ChipSelect({
  id,
  label,
  value,
  options,
  tone,
  onPick,
}: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  tone: string;
  onPick: (v: string) => void;
}) {
  const [shown, setShown] = useState(value);
  useEffect(() => setShown(value), [value]);
  return (
    <label htmlFor={id} className={cn("inline-flex min-w-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium", tone)}>
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] opacity-75">{label}</span>
      <select
        id={id}
        value={shown}
        onChange={(e) => {
          setShown(e.target.value);
          onPick(e.target.value);
        }}
        className="min-w-0 max-w-[14rem] cursor-pointer truncate bg-transparent text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--gold)]/40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-background text-foreground">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The due day chip: a date input; an empty value is not sent */
export function DueChip({ label, value, onPick }: { label: string; value: string; onPick: (day: string) => void }) {
  const [shown, setShown] = useState(value);
  useEffect(() => setShown(value), [value]);
  return (
    <label htmlFor="delegate-due" className="inline-flex items-center gap-2 rounded-full border border-[color:var(--glass-border)] bg-foreground/[0.03] px-3 py-1 text-xs font-medium">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      <input
        id="delegate-due"
        type="date"
        value={shown}
        onChange={(e) => {
          if (!e.target.value) return;
          setShown(e.target.value);
          onPick(e.target.value);
        }}
        className="bg-transparent text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--gold)]/40"
      />
    </label>
  );
}

/** The chips' values from the options, keeping the current one */
export function chipOptions<T extends { key: string; label: string }>(list: T[] | undefined, current: T): { value: string; label: string }[] {
  return withCurrent(list ?? [], current).map((o) => ({ value: o.key, label: o.label }));
}

/** Team tile: the technician and a select to give the ticket to another delegate of the company */
export function TeamTile({ ticket, onPick }: { ticket: DelegateTicket; onPick: (delegateId: string) => void }) {
  const { t } = useTranslation();
  const current = ticket.team.delegate;
  const choices: DelegateRef[] = [...ticket.team.delegates];
  if (current && !choices.some((c) => c.id === current.id)) choices.unshift(current);
  return (
    <Pane className="space-y-2 p-3.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("selfManaged.delegate.ticket.tiles.team")}</p>
      <p className="truncate text-sm font-semibold">{current?.name ?? t("selfManaged.delegate.ticket.tiles.teamNone")}</p>
      {ticket.akabWorking && <p className="text-xs font-medium text-primary">{t("selfManaged.delegate.ticket.akabWorking")}</p>}
      <div className="space-y-1">
        <label htmlFor="delegate-team" className="sr-only">
          {t("selfManaged.delegate.ticket.tiles.teamChange")}
        </label>
        <select
          id="delegate-team"
          value={current?.id ?? ""}
          disabled={choices.length === 0}
          onChange={(e) => {
            if (e.target.value) onPick(e.target.value);
          }}
          className="h-9 w-full rounded-md border bg-transparent px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40 disabled:opacity-60"
        >
          {!current && <option value="">{t("selfManaged.delegate.ticket.tiles.teamNone")}</option>}
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
    </Pane>
  );
}

/** Details tile: when it was opened and when it last moved. No contract, no hours. */
export function DetailsTile({ ticket: x }: { ticket: DelegateTicket }) {
  const { t } = useTranslation();
  return (
    <Pane className="space-y-2 p-3.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("selfManaged.delegate.ticket.tiles.details")}</p>
      <dl className="space-y-1 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{t("selfManaged.delegate.ticket.created")}</dt>
          <dd className="text-right">{dateTime(x.createdAt)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{t("selfManaged.delegate.ticket.lastActivity")}</dt>
          <dd className="text-right">{relativeTime(x.updatedAt)}</dd>
        </div>
      </dl>
    </Pane>
  );
}

/** Client and contact: the company's name, the contact, and a select to change the contact */
export function ClientCard({
  ticket: x,
  contacts,
  onPickContact,
}: {
  ticket: DelegateTicket;
  contacts: DelegateContact[];
  onPickContact: (contactId: string | null) => void;
}) {
  const { t } = useTranslation();
  const contact = contacts.find((c) => c.id === x.contactId) ?? null;
  return (
    <Pane className="space-y-3 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("selfManaged.delegate.ticket.client.title")}</h3>
      <dl className="space-y-1.5 text-sm">
        {x.client && (
          <div>
            <dt className="text-xs text-muted-foreground">{t("selfManaged.delegate.ticket.client.client")}</dt>
            <dd className="font-medium">{x.client}</dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-muted-foreground">{t("selfManaged.delegate.ticket.client.contact")}</dt>
          <dd className="font-medium">{x.contact ?? t("selfManaged.delegate.ticket.client.noContact")}</dd>
        </div>
        {contact?.email && (
          <div>
            <dt className="text-xs text-muted-foreground">{t("selfManaged.delegate.ticket.client.email")}</dt>
            <dd className="break-all">{contact.email}</dd>
          </div>
        )}
      </dl>
      <div className="space-y-1">
        <label htmlFor="delegate-contact" className="text-xs font-medium text-muted-foreground">
          {t("selfManaged.delegate.ticket.client.changeContact")}
        </label>
        <select
          id="delegate-contact"
          value={x.contactId ?? ""}
          onChange={(e) => onPickContact(e.target.value || null)}
          className="h-9 w-full rounded-md border bg-transparent px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40"
        >
          <option value="">{t("selfManaged.delegate.ticket.client.noContact")}</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
    </Pane>
  );
}

/** The contact's other open tickets: the last five, a click opens one */
export function OtherTickets({ ticket, onOpen }: { ticket: DelegateTicket; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  const qs = new URLSearchParams({ status: "open", size: "5", page: "1", exclude: String(ticket.id) });
  if (ticket.contactId) qs.set("contactId", ticket.contactId);
  const others = useQuery({
    queryKey: ["portal", "delegate", "tickets", "others", qs.toString()],
    queryFn: () => api.get<DelegateList>(`${DELEGATE_API}/tickets?${qs.toString()}`),
    enabled: !!ticket.contactId,
  });
  const items = others.data?.items ?? [];
  return (
    <Pane className="space-y-3 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("selfManaged.delegate.ticket.others.title")}</h3>
      {items.length === 0 && <p className="text-xs text-muted-foreground">{t("selfManaged.delegate.ticket.others.empty")}</p>}
      {items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => onOpen(o.id)}
                aria-label={t("selfManaged.delegate.ticket.others.open", { number: o.number })}
                className="flex w-full items-center gap-2 rounded-xl border border-[color:var(--glass-border)] px-2.5 py-2 text-left transition-colors hover:bg-foreground/[0.04]"
              >
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{o.number}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{o.title}</span>
                <StatusBadge status={o.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Pane>
  );
}

const TAG_MAX = 12;
const TAG_LENGTH = 30;

/** Tags of the ticket: chips to remove, a field (Enter adds). Each change is saved at once. */
export function TagsCard({ ticket, onChanged, errorText }: { ticket: DelegateTicket; onChanged: () => void; errorText: (e: unknown) => string }) {
  const { t } = useTranslation();
  const [list, setList] = useState<string[]>(ticket.tags);
  const [draft, setDraft] = useState("");
  useEffect(() => setList(ticket.tags), [ticket.tags]);

  const save = useMutation({
    mutationFn: (tags: string[]) => api.put(`${DELEGATE_API}/tickets/${ticket.id}/tags`, { tags }),
    onSuccess: onChanged,
    onError: (e) => {
      toast.error(errorText(e));
      setList(ticket.tags);
      onChanged();
    },
  });

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (value.length > TAG_LENGTH) {
      toast.error(t("selfManaged.delegate.ticket.tags.tooLong"));
      return;
    }
    setDraft("");
    if (list.includes(value)) return;
    if (list.length >= TAG_MAX) {
      toast.error(t("selfManaged.delegate.ticket.tags.max"));
      return;
    }
    const next = [...list, value];
    setList(next);
    save.mutate(next);
  };

  const remove = (tag: string) => {
    const next = list.filter((x) => x !== tag);
    setList(next);
    save.mutate(next);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  };

  return (
    <Pane className="space-y-3 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("selfManaged.delegate.ticket.tags.title")}</h3>
      {list.length === 0 && <p className="text-xs text-muted-foreground">{t("selfManaged.delegate.ticket.tags.empty")}</p>}
      {list.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {list.map((tag) => (
            <li key={tag} className="inline-flex max-w-full items-center gap-1 rounded-full border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary">
              <span className="truncate">{tag}</span>
              <button
                type="button"
                onClick={() => remove(tag)}
                aria-label={t("selfManaged.delegate.ticket.tags.remove", { tag })}
                className="rounded-full p-0.5 hover:bg-foreground/10"
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          maxLength={TAG_LENGTH}
          placeholder={t("selfManaged.delegate.ticket.tags.placeholder")}
          aria-label={t("selfManaged.delegate.ticket.tags.placeholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          className="h-9"
        />
        <Button type="button" size="sm" variant="outline" className="h-9" onClick={add} disabled={!draft.trim()}>
          {t("selfManaged.delegate.ticket.tags.add")}
        </Button>
      </div>
    </Pane>
  );
}
