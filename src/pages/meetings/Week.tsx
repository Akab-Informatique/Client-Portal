import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, FolderKanban, PartyPopper, Star, Ticket, Trash2, UserX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { AbsenceDialog, type AbsenceDraft } from "./Absences";
import { TicketSearch } from "@/pages/tickets/TicketSearch";
import { useTicketWorkspace } from "@/pages/tickets/workspace";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { holidaysBetween } from "@shared/holidays";

type Block = {
  id: string;
  technicianId: string;
  technicianName: string;
  kind: "work" | "onsite" | "slot";
  title: string;
  ticketId: number | null;
  ticketNumber: string | null;
  companyName: string | null;
  startsAt: string;
  endsAt: string;
  busy: boolean;
};
type Absence = { id: string; userId: string; name: string; startDate: string; endDate: string; kind: AbsenceDraft["kind"]; note: string | null };
type Event = {
  id: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  title: string;
  note: string | null;
  userId: string | null;
  name: string | null;
  ticketId: number | null;
  ticketNumber: string | null;
  ticketTitle: string | null;
};
type LinkedTicket = { id: number; number: string; title: string };
type EventDraft = { id?: string; date: string; startTime: string; endTime: string; title: string; note: string; userId: string; ticket: LinkedTicket | null };
type Week = {
  from: string;
  to: string;
  events: Event[];
  blocks: Block[];
  absences: Absence[];
  projects: { id: string; title: string; client: string | null; dueDate: string }[];
  tickets: { id: number; number: string; title: string; company: string; dueAt: string; assignee: string | null }[];
  ticketsError: boolean;
};

/** Local calendar day as YYYY-MM-DD */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));
const loc = () => (currentLocale() === "en" ? "en-CA" : "fr-CA");
const time = (iso: string) => new Intl.DateTimeFormat(loc(), { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** Absence chips, by kind (same colors as the absences calendar) */
const ABSENCE_CHIP: Record<AbsenceDraft["kind"], string> = {
  vacation: "bg-sky-500/20 text-sky-200",
  sick: "bg-red-500/20 text-red-200",
  training: "bg-violet-500/20 text-violet-200",
  personal: "bg-amber-500/20 text-amber-200",
  other: "bg-slate-500/20 text-slate-200",
};
const EVERYONE = "everyone";

const KIND_STYLE: Record<Block["kind"], string> = {
  work: "border-l-primary",
  onsite: "border-l-emerald-400",
  slot: "border-l-sky-400",
};

/** Weekly meeting: the team's week, day by day; a day opens everything planned on it. */
export function WeekSection() {
  const { t } = useTranslation();
  const manage = useCan()("meetings.manage");
  const [event, setEvent] = useState<EventDraft | null>(null);
  const [absence, setAbsence] = useState<AbsenceDraft | null>(null);
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [selected, setSelected] = useState(() => ymd(new Date()));
  const from = ymd(monday);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const holidays = useMemo(() => holidaysBetween(from, ymd(addDays(monday, 6))), [from, monday]);
  const today = ymd(new Date());
  const { data, isLoading, isError } = useQuery({
    queryKey: ["meetings", "week", from],
    queryFn: () => api.get<Week>(`/meetings/week?from=${from}`),
    refetchInterval: 30_000,
  });

  /** Everything on one day */
  const on = (day: string) => ({
    events: (data?.events ?? []).filter((x) => x.date === day),
    blocks: (data?.blocks ?? []).filter((b) => ymd(new Date(b.startsAt)) === day),
    absences: (data?.absences ?? []).filter((x) => x.startDate <= day && x.endDate >= day),
    tickets: (data?.tickets ?? []).filter((x) => ymd(new Date(x.dueAt)) === day),
    projects: (data?.projects ?? []).filter((x) => x.dueDate === day),
  });
  const go = (weeks: number) => {
    const m = addDays(monday, weeks * 7);
    setMonday(m);
    setSelected(weeks === 0 ? today : ymd(m));
  };
  const day = on(selected);
  const selDate = new Date(`${selected}T12:00:00`);
  const range = `${new Intl.DateTimeFormat(loc(), { day: "numeric", month: "short" }).format(monday)} – ${new Intl.DateTimeFormat(loc(), { day: "numeric", month: "short", year: "numeric" }).format(addDays(monday, 6))}`;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <CalendarDays className="size-5 text-primary" /> {t("meetings.week.title")}
        </h2>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-sm text-muted-foreground">{range}</span>
          <Button variant="ghost" size="icon" className="size-8" aria-label={t("meetings.week.previous")} onClick={() => go(-1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-8" onClick={() => go(0)}>
            {t("meetings.week.thisWeek")}
          </Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label={t("meetings.week.next")} onClick={() => go(1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-2xl border bg-card/80">
        <div className="grid grid-cols-7 divide-x border-b">
          {days.map((d) => {
            const key = ymd(d);
            const x = on(key);
            const weekend = d.getDay() === 0 || d.getDay() === 6;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={selected === key}
                onClick={() => setSelected(key)}
                className={cn(
                  "flex min-h-24 min-w-0 flex-col items-stretch gap-1 p-1.5 text-left transition-colors hover:bg-accent/50",
                  weekend && "bg-teal-400/[0.05]",
                  selected === key && "bg-primary/10 ring-1 ring-inset ring-primary/60",
                )}
              >
                <span className="flex items-baseline justify-between gap-1">
                  <span className="truncate text-[11px] uppercase text-muted-foreground">{new Intl.DateTimeFormat(loc(), { weekday: "short" }).format(d)}</span>
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                      key === today && "bg-primary text-primary-foreground",
                    )}
                  >
                    {d.getDate()}
                  </span>
                </span>
                {holidays.get(key) && (
                  <span className="truncate text-[10px] text-amber-300" title={t(`meetings.absences.holiday.${holidays.get(key)}`)}>
                    {t(`meetings.absences.holiday.${holidays.get(key)}`)}
                  </span>
                )}
                {[
                  ...x.events.map((e) => ({ id: e.id, label: e.title, style: "bg-[color:var(--gold)]/15 text-primary" })),
                  ...x.absences.map((a) => ({ id: a.id, label: a.name, style: ABSENCE_CHIP[a.kind] })),
                ]
                  .slice(0, 3)
                  .map((c) => (
                    <span key={c.id} title={c.label} className={cn("block truncate rounded px-1 text-[10px] leading-4", c.style)}>
                      {c.label}
                    </span>
                  ))}
                {x.events.length + x.absences.length > 3 && (
                  <span className="text-[10px] text-muted-foreground">+{x.events.length + x.absences.length - 3}</span>
                )}
                {data && (
                  <span className="mt-auto flex flex-wrap gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
                    <Count icon={CalendarClock} n={x.blocks.length} label={t("meetings.week.blocks")} />
                    <Count icon={Ticket} n={x.tickets.length} label={t("meetings.week.tickets")} className="text-orange-300" />
                    <Count icon={FolderKanban} n={x.projects.length} label={t("meetings.week.projects")} className="text-violet-300" />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="max-h-[26rem] space-y-4 overflow-y-auto p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold first-letter:uppercase">
              {new Intl.DateTimeFormat(loc(), { weekday: "long", day: "numeric", month: "long" }).format(selDate)}
            </h3>
            {manage && (
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => setEvent({ date: selected, startTime: "", endTime: "", title: "", note: "", userId: EVERYONE, ticket: null })}
                >
                  <CalendarPlus className="size-4" /> {t("meetings.week.addEvent")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => setAbsence({ userId: "", startDate: selected, endDate: selected, kind: "vacation", note: "" })}
                >
                  <UserX className="size-4" /> {t("meetings.week.addAbsence")}
                </Button>
              </div>
            )}
          </div>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ) : isError || !data ? (
            <p className="text-sm text-muted-foreground">{t("common.error")}</p>
          ) : (
            <>
              {holidays.get(selected) && (
                <p className="flex items-center gap-2 text-sm text-amber-300">
                  <PartyPopper className="size-4" /> {t(`meetings.absences.holiday.${holidays.get(selected)}`)}
                </p>
              )}
              {!day.events.length && !day.blocks.length && !day.absences.length && !day.tickets.length && !day.projects.length && !holidays.get(selected) && (
                <p className="text-sm text-muted-foreground">{t("meetings.week.nothing")}</p>
              )}
              {day.events.length > 0 && (
                <Group icon={Star} title={t("meetings.week.events")} className="text-primary">
                  {day.events.map((x) => (
                    <li key={x.id}>
                      <Row
                        editable={manage}
                        onClick={() =>
                          setEvent({
                            id: x.id,
                            date: x.date,
                            startTime: x.startTime ?? "",
                            endTime: x.endTime ?? "",
                            title: x.title,
                            note: x.note ?? "",
                            userId: x.userId ?? EVERYONE,
                            ticket: x.ticketId ? { id: x.ticketId, number: x.ticketNumber ?? "", title: x.ticketTitle ?? "" } : null,
                          })
                        }
                      >
                        <span className="text-xs text-muted-foreground">
                          {x.startTime ? (x.endTime ? `${x.startTime} – ${x.endTime}` : x.startTime) : t("meetings.week.allDay")}
                          {" · "}
                          {x.name ?? t("meetings.week.everyone")}
                        </span>
                        <span className="block font-medium">{x.title}</span>
                        {x.note && <span className="block text-muted-foreground">{x.note}</span>}
                      </Row>
                      {x.ticketId && (
                        <TicketLink
                          id={x.ticketId!}
                          className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
                        >
                          <Ticket className="size-3.5 shrink-0 text-orange-300" />
                          <span className="shrink-0 font-mono">{x.ticketNumber}</span>
                          <span className="truncate">{x.ticketTitle}</span>
                        </TicketLink>
                      )}
                    </li>
                  ))}
                </Group>
              )}
              {day.absences.length > 0 && (
                <Group icon={UserX} title={t("meetings.week.absences")} className="text-sky-300">
                  {day.absences.map((x) => (
                    <li key={x.id}>
                      <Row
                        editable={manage}
                        onClick={() => setAbsence({ id: x.id, userId: x.userId, startDate: x.startDate, endDate: x.endDate, kind: x.kind, note: x.note ?? "" })}
                      >
                        <span className={cn("mr-1.5 inline-block size-2 rounded-full", ABSENCE_CHIP[x.kind])} />
                        <span className="font-medium">{x.name}</span>
                        <span className="text-muted-foreground"> · {t(`meetings.absences.kind.${x.kind}`)}</span>
                        {x.startDate !== x.endDate && (
                          <span className="text-muted-foreground">
                            {" "}
                            ({x.startDate} → {x.endDate})
                          </span>
                        )}
                        {x.note && <span className="text-muted-foreground"> — {x.note}</span>}
                      </Row>
                    </li>
                  ))}
                </Group>
              )}
              {day.blocks.length > 0 && (
                <Group icon={CalendarClock} title={t("meetings.week.blocks")} className="text-primary">
                  {day.blocks.map((b) => (
                    <li key={b.id} className={cn("rounded-md border-l-2 bg-muted/40 px-2.5 py-1.5 text-sm", KIND_STYLE[b.kind])}>
                      <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                        <span>
                          {time(b.startsAt)} – {time(b.endsAt)}
                        </span>
                        <span className="truncate">{b.technicianName}</span>
                      </div>
                      {b.busy ? (
                        <p className="italic text-muted-foreground">{t("planning.busy")}</p>
                      ) : (
                        <p className="truncate">
                          <span className="text-muted-foreground">{t(`planning.kind.${b.kind}`)} · </span>
                          {b.ticketId ? (
                            <TicketLink id={b.ticketId!} className="hover:underline">
                              {b.ticketNumber && <span className="font-mono text-xs">{b.ticketNumber} </span>}
                              {b.title}
                            </TicketLink>
                          ) : (
                            b.title
                          )}
                          {b.companyName && <span className="text-muted-foreground"> — {b.companyName}</span>}
                        </p>
                      )}
                    </li>
                  ))}
                </Group>
              )}
              {(day.tickets.length > 0 || data.ticketsError) && (
                <Group icon={Ticket} title={t("meetings.week.tickets")} className="text-orange-300">
                  {data.ticketsError && <li className="text-sm text-muted-foreground">{t("meetings.week.ticketsError")}</li>}
                  {day.tickets.map((x) => (
                    <li key={x.id} className="text-sm">
                      <TicketLink id={x.id!} className="flex w-full items-baseline gap-2 hover:underline">
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">{x.number}</span>
                        <span className="min-w-0 truncate">{x.title}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{x.assignee ?? t("meetings.overdue.unassigned")}</span>
                      </TicketLink>
                    </li>
                  ))}
                </Group>
              )}
              {day.projects.length > 0 && (
                <Group icon={FolderKanban} title={t("meetings.week.projects")} className="text-violet-300">
                  {day.projects.map((x) => (
                    <li key={x.id} className="text-sm">
                      <span className="font-medium">{x.title}</span>
                      {x.client && <span className="text-muted-foreground"> — {x.client}</span>}
                    </li>
                  ))}
                </Group>
              )}
            </>
          )}
        </div>
      </div>
      {event && <EventDialog draft={event} onClose={() => setEvent(null)} />}
      {absence && <AbsenceDialog draft={absence} onClose={() => setAbsence(null)} />}
    </section>
  );
}

function Count({ icon: Icon, n, label, className }: { icon: typeof Ticket; n: number; label: string; className?: string }) {
  if (!n) return null;
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} title={`${n} · ${label}`}>
      <Icon className="size-3" /> {n}
    </span>
  );
}

function Group({ icon: Icon, title, className, children }: { icon: typeof Ticket; title: string; className?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className={cn("flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide", className)}>
        <Icon className="size-3.5" /> {title}
      </h4>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  );
}

/** A line of the day: opens its editor for meetings.manage */
function Row({ editable, onClick, children }: { editable: boolean; onClick: () => void; children: React.ReactNode }) {
  if (!editable) return <div className="text-sm">{children}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-1.5 block w-[calc(100%+0.75rem)] rounded-md px-1.5 py-0.5 text-left text-sm transition-colors hover:bg-accent/50"
    >
      {children}
    </button>
  );
}

/** Something on the team week: a title, a day, optional hours and person. */
function EventDialog({ draft, onClose }: { draft: EventDraft; onClose: () => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [d, setD] = useState(draft);
  const team = useQuery({ queryKey: ["meetings", "team"], queryFn: () => api.get<{ id: string; name: string }[]>("/meetings/team"), staleTime: 5 * 60_000 });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["meetings", "week"] });
    onClose();
  };
  const onError = (e: unknown) =>
    toast.error(
      e instanceof ApiError && e.fields?.some((f) => f.message === "end_before_start")
        ? t("meetings.week.endBeforeStart")
        : e instanceof ApiError && e.code === "invalid_ticket"
          ? t("meetings.week.invalidTicket")
          : t("common.error"),
    );
  const save = useMutation({
    mutationFn: () => {
      const payload = {
        date: d.date,
        startTime: d.startTime,
        endTime: d.endTime,
        title: d.title,
        note: d.note,
        userId: d.userId === EVERYONE ? null : d.userId,
        ticketId: d.ticket?.id ?? null,
      };
      return d.id ? api.put(`/meetings/events/${d.id}`, payload) : api.post("/meetings/events", payload);
    },
    onSuccess: done,
    onError,
  });
  const remove = useMutation({ mutationFn: () => api.del(`/meetings/events/${d.id}`), onSuccess: done, onError });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (d.title.trim() && d.date) save.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(d.id ? "meetings.week.editEvent" : "meetings.week.newEvent")}</DialogTitle>
          <DialogDescription>{t("meetings.week.eventText")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ev-title">{t("meetings.week.eventTitle")}</Label>
            <Input
              id="ev-title"
              autoFocus
              required
              maxLength={200}
              placeholder={t("meetings.week.eventPlaceholder")}
              value={d.title}
              onChange={(e) => setD({ ...d, title: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ev-date">{t("meetings.week.date")}</Label>
              <Input id="ev-date" type="date" required value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-start">{t("meetings.week.start")}</Label>
              <Input id="ev-start" type="time" value={d.startTime} onChange={(e) => setD({ ...d, startTime: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-end">{t("meetings.week.end")}</Label>
              <Input id="ev-end" type="time" disabled={!d.startTime} value={d.endTime} onChange={(e) => setD({ ...d, endTime: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("meetings.week.person")}</Label>
            <Select value={d.userId} onValueChange={(userId) => setD({ ...d, userId })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EVERYONE}>{t("meetings.week.everyone")}</SelectItem>
                {(team.data ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-note">{t("meetings.absences.note")}</Label>
            <Input id="ev-note" maxLength={1000} value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("meetings.week.ticket")}</Label>
            {d.ticket ? (
              <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                <Ticket className="size-4 shrink-0 text-orange-300" />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{d.ticket.number}</span>
                <span className="min-w-0 flex-1 truncate">{d.ticket.title}</span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-red-400"
                  aria-label={t("meetings.week.unlinkTicket")}
                  onClick={() => setD({ ...d, ticket: null })}
                >
                  <X className="size-4" />
                </button>
              </div>
            ) : (
              <TicketSearch autoFocus={false} onPick={(ticket) => setD({ ...d, ticket, title: d.title || ticket.title })} />
            )}
          </div>
          <div className="flex items-center gap-2 pt-2">
            {d.id && (
              <Button
                type="button"
                variant="ghost"
                className="text-red-400"
                onClick={() => void confirm({ title: t("meetings.week.deleteEvent"), destructive: true }).then((ok) => ok && remove.mutate())}
              >
                <Trash2 className="size-4" /> {t("common.delete")}
              </Button>
            )}
            <Button type="button" variant="ghost" className="ml-auto" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!d.title.trim() || save.isPending}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A ticket opened over the meeting (closing it comes back here). */
function TicketLink({ id, className, children }: { id: number; className?: string; children: React.ReactNode }) {
  const ws = useTicketWorkspace();
  return (
    <button type="button" onClick={() => ws.open(id)} className={cn("text-left", className)}>
      {children}
    </button>
  );
}
