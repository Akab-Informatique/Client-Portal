import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BarChart3, Car, ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, Clock, FileText, ListTree, Loader2, PartyPopper, PiggyBank, Pencil, Plus, Send, Sun, Thermometer, Ticket, Trash2, TreePalm, UserCog, Users, type LucideIcon } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { unpaidLunch } from "@shared/workday";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useTicketWorkspace } from "@/pages/tickets/workspace";
import { TicketSearch } from "@/pages/tickets/TicketSearch";

export type TimeKind = "labour" | "workday" | "bankpay" | "vacation" | "sick" | "holiday" | "travel" | "other";
export type TimeType = { id: string; name: string; kind: TimeKind; active: boolean; billable: boolean };
type Entry = {
  id: string;
  date: string;
  typeId: string;
  type: string;
  kind: TimeKind;
  hours: number;
  note: string | null;
  ticketId: number | null;
  ticketNumber: string | null;
  ticketTitle: string | null;
  startTime: string | null;
  endTime: string | null;
  lunchMinutes: number | null;
  /** A work day: hours (×100) put in the hours bank instead of being paid */
  bankX100: number;
  /** A trip billed to a client, or the holiday pay worked out */
  amountCents: number | null;
  billableX100: number | null;
  clientId: string | null;
  source: "ticket" | "manual" | "project";
};
type Person = { id: string; name: string; email: string; timesheetRequired: boolean };
type Pay = {
  wageCents: number | null;
  workdayHours: number;
  bankedHours: number;
  workdayPaidHours: number;
  vacationHours: number;
  sickHours: number;
  holidayHours: number;
  holidayCents: number;
  bankPaidHours: number;
  paidHours: number;
};
type Week = {
  userId: string;
  required: boolean;
  weekStart: string;
  weekEnd: string;
  status: "draft" | "submitted" | "approved" | "rejected" | "paid";
  comment: string | null;
  entries: Entry[];
  types: { type: string; kind: string; hours: number }[];
  /** Time entered on tickets and by hand (training, meetings, trips) */
  enteredHours: number;
  pay: Pay;
};

const STATUS_STYLE: Record<Week["status"], string> = {
  draft: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  submitted: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  approved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  rejected: "border-red-500/40 bg-red-500/10 text-red-300",
  paid: "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary",
};
const KIND_ICON: Record<string, { icon: LucideIcon; tone: string }> = {
  workday: { icon: Sun, tone: "text-amber-300" },
  bankpay: { icon: PiggyBank, tone: "text-sky-300" },
  vacation: { icon: TreePalm, tone: "text-emerald-300" },
  sick: { icon: Thermometer, tone: "text-rose-300" },
  holiday: { icon: PartyPopper, tone: "text-violet-300" },
  travel: { icon: Car, tone: "text-primary" },
  labour: { icon: Ticket, tone: "text-primary" },
  other: { icon: Users, tone: "text-muted-foreground" },
};
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const minutesOf = (t: string) => (t.length >= 5 ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : NaN);
/** The hours of an entry that are paid to the employee: the work day less what is banked, vacation, sick days, holidays and bank payouts. The rest is time entered inside the work day. */
const paidOf = (e: Entry) => (e.kind === "workday" ? Math.max(0, e.hours - e.bankX100 / 100) : ["vacation", "sick", "holiday", "bankpay"].includes(e.kind) ? e.hours : 0);
const isEntered = (e: Entry) => ["labour", "other", "travel"].includes(e.kind);

/** A figure of a day: a small label over its value */
function Figure({ label, value, tone }: { label: string; value: string; tone?: "good" | "muted" }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-sm font-semibold", tone === "good" && "text-emerald-300", tone === "muted" && "text-muted-foreground")}>{value}</span>
    </span>
  );
}

/** What went wrong, in words */
function useErrorText() {
  const { t } = useTranslation();
  return (e: unknown) => {
    const code = e instanceof ApiError ? e.code : "";
    const known: Record<string, string> = {
      timesheet_locked: "timesheet.locked",
      workday_exists: "timesheet.workdayExists",
      workday_times: "timesheet.workdayTimes",
      bank_too_large: "timesheet.bankTooLarge",
      hr_wage_missing: "timesheet.wageMissing",
      travel_amount_required: "timesheet.travelAmountRequired",
      travel_client_required: "timesheet.travelClientRequired",
      entry_billed: "timesheet.entryBilled",
    };
    return t(known[code] ?? "common.error");
  };
}

/**
 * My tools › Timesheet: the week. Time logged on tickets is already there (with the ticket; a click opens it); the other
 * entries are added by type: work day (start, end, hours put in the bank), hours paid out of the bank, training, meeting, trip,
 * vacation, sick day, holiday. The side shows the hours that are PAID this week (work days, vacation, sick days, holidays,
 * bank payouts); billable and non billable time are kept per client and are not shown here.
 */
export function TimesheetPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const can = useCan();
  const ws = useTicketWorkspace();
  const errorText = useErrorText();
  // managers pick whose timesheet (their own by default)
  const manager = can("timesheets.manage");
  const [who, setWho] = useState(me.id);
  const others = who !== me.id;
  const { data: people } = useQuery({ queryKey: ["time", "people"], queryFn: () => api.get<Person[]>("/time/people"), enabled: manager });
  const [start, setStart] = useState<string | null>(null);
  const q = new URLSearchParams({ ...(start ? { start } : {}), ...(others ? { userId: who } : {}) }).toString();
  const { data: week, isLoading } = useQuery({ queryKey: ["time", "week", who, start], queryFn: () => api.get<Week>(`/time/week${q ? `?${q}` : ""}`) });
  const person = people?.find((x) => x.id === who);
  const editable = week?.status === "draft" || week?.status === "rejected";
  // the days start minimized; a day opens to its figures, and its details (each entry) open on their own
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [detail, setDetail] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState<Entry | null>(null);
  const [report, setReport] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["time", "week"] });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/time/entries/${id}`),
    onSuccess: refresh,
    onError: (e) => toast.error(errorText(e)),
  });
  const submit = useMutation({
    mutationFn: () => api.post("/time/week/submit", { weekStart: week!.weekStart, ...(others ? { userId: who } : {}) }),
    onSuccess: () => {
      refresh();
      toast.success(t("timesheet.submitted"));
    },
  });
  const loc = i18n.language === "en" ? "en-CA" : "fr-CA";
  const dayName = (d: string) => new Intl.DateTimeFormat(loc, { weekday: "long", day: "numeric", month: "short" }).format(new Date(`${d}T12:00:00`));
  const days = week ? Array.from({ length: 7 }, (_, i) => addDays(week.weekStart, i)) : [];
  const hours = (n: number) => n.toLocaleString(loc, { maximumFractionDigits: 2 });
  const money = (cents: number) => new Intl.NumberFormat(loc, { style: "currency", currency: "CAD" }).format(cents / 100);
  const workdays = week?.entries.filter((e) => e.kind === "workday") ?? [];
  const allOpen = days.length > 0 && days.every((d) => open[d]);
  // an entry made by hand: its owner changes it until the week is sent; a manager any time
  const canChange = (e: Entry) => e.source === "manual" && (editable || manager);

  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Clock className="size-6 text-primary" /> {t("timesheet.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("timesheet.subtitle")}</p>
        </div>
        {manager && people && (
          <Select value={who} onValueChange={setWho}>
            <SelectTrigger className="w-64" aria-label={t("timesheet.person")}>
              <UserCog className="size-4 text-primary" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {people.map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {x.id === me.id ? t("timesheet.me", { name: x.name }) : x.name}
                  {!x.timesheetRequired && <span className="text-xs text-muted-foreground"> · {t("timesheet.noSubmit")}</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {week && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => setStart(addDays(week.weekStart, -7))} aria-label={t("timesheet.previous")}>
              <ChevronLeft className="size-4" />
            </Button>
            <span className="min-w-52 text-center text-sm font-medium">
              {new Intl.DateTimeFormat(loc, { day: "numeric", month: "long" }).format(new Date(`${week.weekStart}T12:00:00`))} →{" "}
              {new Intl.DateTimeFormat(loc, { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${week.weekEnd}T12:00:00`))}
            </span>
            <Button variant="outline" size="icon" onClick={() => setStart(addDays(week.weekStart, 7))} aria-label={t("timesheet.next")}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
        )}
      </div>
      {others && person && (
        <p className="flex items-center gap-2 rounded-xl border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 px-3 py-2 text-sm">
          <UserCog className="size-4 text-primary" /> {t("timesheet.managing", { name: person.name })}
        </p>
      )}
      {isLoading && <Loader2 className="mx-auto my-10 size-6 animate-spin text-muted-foreground" />}
      {week && (
        <div className="flex flex-wrap items-center gap-2">
          {(editable || manager) && (
            <Button className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> {t("timesheet.addEntry")}
            </Button>
          )}
          <Button variant="outline" onClick={() => setReport(true)}>
            <BarChart3 className="size-4" /> {t("timesheet.report")}
          </Button>
          {week.status !== "draft" && (
            <Button variant="outline" asChild>
              <a href={`/api/time/week/pdf?start=${week.weekStart}${others ? `&userId=${who}` : ""}`} target="_blank" rel="noreferrer">
                <FileText className="size-4" /> {t("timesheet.pdf")}
              </a>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto gap-1.5 text-muted-foreground"
            onClick={() => {
              setOpen(allOpen ? {} : Object.fromEntries(days.map((d) => [d, true])));
              if (allOpen) setDetail({});
            }}
          >
            {allOpen ? <ChevronsDownUp className="size-4" /> : <ChevronsUpDown className="size-4" />} {allOpen ? t("timesheet.collapseAll") : t("timesheet.expandAll")}
          </Button>
        </div>
      )}
      {week && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-3">
            {days.map((d) => {
              const list = week.entries.filter((e) => e.date === d);
              const entered = list.filter(isEntered).reduce((x, e) => x + e.hours, 0);
              const wd = list.filter((e) => e.kind === "workday").reduce((x, e) => x + e.hours, 0);
              const banked = list.filter((e) => e.kind === "workday").reduce((x, e) => x + e.bankX100 / 100, 0);
              const paid = list.reduce((x, e) => x + paidOf(e), 0);
              const isOpen = Boolean(open[d]);
              const showDetail = Boolean(detail[d]);
              return (
                <section key={d} className={cn("glass rounded-2xl border", !list.length && "opacity-70")}>
                  <button type="button" aria-expanded={isOpen} onClick={() => setOpen((c) => ({ ...c, [d]: !c[d] }))} className="flex w-full items-center gap-3 px-4 py-2 text-left">
                    <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !isOpen && "-rotate-90")} />
                    <span className="flex-1 text-sm font-semibold capitalize">{dayName(d)}</span>
                    {wd > 0 && (
                      <span className="flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-px text-[11px] text-amber-300" title={t("timesheet.workday")}>
                        <Sun className="size-3" /> {hours(wd)} h
                      </span>
                    )}
                    {banked > 0 && (
                      <span className="flex items-center gap-1 rounded-full border border-sky-400/30 bg-sky-500/10 px-2 py-px text-[11px] text-sky-300" title={t("timesheet.bankedWeek")}>
                        <PiggyBank className="size-3" /> {hours(banked)} h
                      </span>
                    )}
                    <span className="font-mono text-sm" title={t("timesheet.paidDay")}>
                      {paid ? `${hours(paid)} h` : "—"}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="space-y-2 border-t px-4 py-2.5">
                      {list.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("timesheet.dayEmpty")}</p>
                      ) : (
                        <>
                          {/* the figures of the day, and the way to its details */}
                          <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-sm">
                            <Figure label={t("timesheet.workday")} value={`${hours(wd)} h`} />
                            <Figure label={t("timesheet.entered")} value={`${hours(entered)} h`} tone={entered < wd - 0.001 ? "muted" : undefined} />
                            <Figure label={t("timesheet.paidDay")} value={`${hours(paid)} h`} tone="good" />
                            <button
                              type="button"
                              onClick={() => setDetail((c) => ({ ...c, [d]: !c[d] }))}
                              aria-expanded={showDetail}
                              className="ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-primary transition hover:bg-[color:var(--gold)]/10"
                            >
                              <ListTree className="size-3.5" /> {showDetail ? t("timesheet.hideDetails") : t("timesheet.details")}
                            </button>
                          </div>
                          {showDetail && (
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                                  <th className="py-1 pr-2 font-medium">{t("timesheet.colEntry")}</th>
                                  <th className="w-20 py-1 text-right font-medium">{t("timesheet.colHours")}</th>
                                  <th className="w-16 py-1" />
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border/50">
                                {list.map((e) => {
                                  const openTicket = e.ticketId != null && e.kind === "labour" && can("tickets.view");
                                  const { icon: Icon, tone } = KIND_ICON[e.kind] ?? KIND_ICON.other;
                                  const name = e.kind === "workday" ? (e.startTime && e.endTime ? `${e.type} · ${e.startTime}–${e.endTime}` : e.type) : e.source === "ticket" ? null : e.ticketNumber && e.kind === "travel" ? `${e.type} · ${e.ticketNumber}` : e.type;
                                  const label = (
                                    <span className="flex min-w-0 items-center gap-2">
                                      <Icon className={cn("size-3.5 shrink-0", tone)} />
                                      {name === null ? (
                                        <span className="min-w-0 truncate">
                                          <span className="font-mono text-xs text-muted-foreground">{e.ticketNumber}</span> {e.ticketTitle}
                                        </span>
                                      ) : (
                                        <span className="min-w-0 truncate">{name}</span>
                                      )}
                                      {e.kind === "workday" && e.bankX100 > 0 && (
                                        <span className="flex shrink-0 items-center gap-1 rounded-full border border-sky-400/40 bg-sky-500/10 px-1.5 py-px text-[10px] font-medium text-sky-300">
                                          <PiggyBank className="size-2.5" /> {hours(e.bankX100 / 100)} h
                                        </span>
                                      )}
                                      {e.kind === "holiday" && e.amountCents != null && week.pay.wageCents != null && <span className="shrink-0 text-[10px] text-violet-300">{money(e.amountCents)}</span>}
                                      {e.kind === "travel" && e.amountCents != null && <span className="shrink-0 text-[10px] text-emerald-300">{t("timesheet.travelBilled", { amount: money(e.amountCents) })}</span>}
                                    </span>
                                  );
                                  return (
                                    <tr key={e.id} className="group" title={e.note ?? undefined}>
                                      <td className="max-w-0 py-1.5 pr-2">
                                        {openTicket ? (
                                          <button type="button" title={t("timesheet.openTicket")} onClick={() => ws.open(e.ticketId!)} className="block w-full rounded px-1 py-0.5 text-left transition hover:bg-accent/50">
                                            {label}
                                          </button>
                                        ) : (
                                          <span className="block px-1 py-0.5">{label}</span>
                                        )}
                                      </td>
                                      <td className="py-1.5 text-right font-mono">{e.kind === "bankpay" ? `−${hours(e.hours)}` : hours(e.hours)}</td>
                                      <td className="py-1.5 text-right">
                                        {canChange(e) && (
                                          <button type="button" onClick={() => setChanging(e)} className="rounded p-1 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100" aria-label={t("timesheet.change")}>
                                            <Pencil className="size-3.5" />
                                          </button>
                                        )}
                                        {canChange(e) && (
                                          <button type="button" onClick={() => remove.mutate(e.id)} className="rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100" aria-label={t("timesheet.remove")}>
                                            <Trash2 className="size-3.5" />
                                          </button>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          <aside className="space-y-4">
            <section className="glass space-y-3 rounded-2xl border p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{others && person ? t("timesheet.theirWeek", { name: person.name }) : t("timesheet.week")}</span>
                <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px]", STATUS_STYLE[week.status])}>{t(`timesheet.status.${week.status}`)}</span>
              </div>
              {week.status === "rejected" && week.comment && <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200">{week.comment}</p>}

              {/* the work days: start to end, lunch taken off */}
              <div className="rounded-xl border border-amber-400/25 bg-amber-500/[0.06] p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Sun className="size-3.5 text-amber-300" /> {t("timesheet.workdays")}
                  </span>
                  <span className="font-mono">{hours(week.pay.workdayHours)} h</span>
                </div>
                {workdays.length > 0 ? (
                  <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
                    {workdays.map((e) => (
                      <li key={e.id} className="flex justify-between gap-2">
                        <span className="capitalize">{new Intl.DateTimeFormat(loc, { weekday: "short", day: "numeric" }).format(new Date(`${e.date}T12:00:00`))}</span>
                        <span>
                          {e.startTime}–{e.endTime} · {hours(e.hours)} h
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[11px] text-muted-foreground">{t("timesheet.noWorkday")}</p>
                )}
              </div>

              {/* hours per type */}
              <ul className="space-y-1 text-sm">
                {week.types.map((x) => (
                  <li key={x.type} className="flex items-center justify-between gap-2">
                    <span className="truncate">{x.type}</span>
                    <span className="font-mono">{hours(x.hours)} h</span>
                  </li>
                ))}
                {!week.types.length && <li className="text-xs text-muted-foreground">{t("timesheet.empty")}</li>}
              </ul>

              {/* what is PAID this week */}
              <div className="space-y-1.5 rounded-xl border border-emerald-400/25 bg-emerald-500/[0.05] p-3 text-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-300">{t("timesheet.paid")}</p>
                <div className="flex justify-between">
                  <span>{t("timesheet.paidWorkdays")}</span>
                  <span className="font-mono">{hours(week.pay.workdayPaidHours)} h</span>
                </div>
                {week.pay.bankedHours > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <PiggyBank className="size-3 text-sky-300" /> {t("timesheet.bankedWeek")}
                    </span>
                    <span className="font-mono text-sky-300">{hours(week.pay.bankedHours)} h</span>
                  </div>
                )}
                {week.pay.vacationHours > 0 && (
                  <div className="flex justify-between">
                    <span>{t("timesheet.paidVacation")}</span>
                    <span className="font-mono">{hours(week.pay.vacationHours)} h</span>
                  </div>
                )}
                {week.pay.sickHours > 0 && (
                  <div className="flex justify-between">
                    <span>{t("timesheet.paidSick")}</span>
                    <span className="font-mono">{hours(week.pay.sickHours)} h</span>
                  </div>
                )}
                {week.pay.holidayHours > 0 && (
                  <div className="flex justify-between">
                    <span>{t("timesheet.paidHoliday")}</span>
                    <span className="font-mono">
                      {hours(week.pay.holidayHours)} h {week.pay.wageCents != null && <span className="text-[11px] text-violet-300">({money(week.pay.holidayCents)})</span>}
                    </span>
                  </div>
                )}
                {week.pay.bankPaidHours > 0 && (
                  <div className="flex justify-between">
                    <span>{t("timesheet.paidBank")}</span>
                    <span className="font-mono">{hours(week.pay.bankPaidHours)} h</span>
                  </div>
                )}
                <div className="flex justify-between border-t pt-1.5 font-semibold">
                  <span>{t("timesheet.paidTotal")}</span>
                  <span className="font-mono">{hours(week.pay.paidHours)} h</span>
                </div>
              </div>

              {!week.required && <p className="rounded-lg border bg-background/40 p-2 text-xs text-muted-foreground">{t("timesheet.notRequired")}</p>}
              {editable && week.required && week.entries.length > 0 && <p className="text-[11px] text-amber-300">{t("timesheet.toSubmit")}</p>}
              {editable && week.required && (
                <Button className="w-full bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" disabled={submit.isPending || !week.entries.length} onClick={() => submit.mutate()}>
                  {submit.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("timesheet.submit")}
                </Button>
              )}
            </section>
          </aside>
        </div>
      )}

      {week && changing && <EntryDialog key={changing.id} entry={changing} onOpenChange={(o) => !o && setChanging(null)} week={week} days={days} dayName={dayName} userId={others ? who : null} onDone={refresh} />}
      {week && adding && <EntryDialog key="new" onOpenChange={setAdding} week={week} days={days} dayName={dayName} userId={others ? who : null} onDone={refresh} />}
      {week && <ReportDialog open={report} onOpenChange={setReport} week={week} days={days} dayName={dayName} hours={hours} personName={others && person ? person.name : me.name} />}
    </div>
  );
}

type TicketPick = { id: number; number: string; title: string };

/**
 * Add an entry, or change one made by hand (`entry`). What it asks depends on the type: a work day takes its start and end
 * (lunch taken off) and the hours put in the hours bank; a holiday is worked out for you; a trip can name a client and a
 * ticket and be billed with an amount; everything else is hours.
 */
function EntryDialog({
  entry,
  onOpenChange,
  week,
  days,
  dayName,
  userId,
  onDone,
}: {
  entry?: Entry;
  onOpenChange: (o: boolean) => void;
  week: Week;
  days: string[];
  dayName: (d: string) => string;
  userId: string | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { data: types } = useQuery({ queryKey: ["time", "types"], queryFn: () => api.get<{ time: TimeType[] }>("/time/types") });
  // only what a person can enter by hand: ticket time comes from the tickets
  const manual = (types?.time ?? []).filter((x) => x.kind !== "labour");
  const [f, setF] = useState({
    date: entry?.date ?? week.weekStart,
    typeId: entry?.typeId ?? "",
    hours: entry && entry.kind !== "workday" ? String(entry.hours) : "",
    note: entry?.note ?? "",
    start: entry?.startTime ?? "08:00",
    end: entry?.endTime ?? "16:30",
    bank: entry && entry.bankX100 ? String(entry.bankX100 / 100) : "",
    clientId: entry?.clientId ?? "",
    billable: (entry?.billableX100 ?? 0) > 0,
    amount: entry?.amountCents != null && entry.kind === "travel" ? String(entry.amountCents / 100) : "",
  });
  const [ticket, setTicket] = useState<TicketPick | null>(entry?.ticketId ? { id: entry.ticketId, number: entry.ticketNumber ?? "", title: entry.ticketTitle ?? "" } : null);
  const type = manual.find((x) => x.id === f.typeId);
  const kind = type?.kind ?? entry?.kind;
  const num = (v: string) => Number(v.replace(",", "."));
  const span = minutesOf(f.end) - minutesOf(f.start) - unpaidLunch(minutesOf(f.start), minutesOf(f.end));
  const workdayOk = Number.isFinite(span) && span > 0 && span <= 24 * 60;
  const bankAsked = f.bank ? num(f.bank) : 0;
  const { data: clients } = useQuery({ queryKey: ["crm", "clients", "pick"], queryFn: () => api.get<{ id: string; name: string }[]>("/crm/clients"), enabled: kind === "travel" });
  const hoursAsked = num(f.hours);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        date: f.date,
        note: entry ? f.note : f.note || undefined,
        ...(kind === "workday" ? { start: f.start, end: f.end, bankHours: bankAsked } : kind === "holiday" ? {} : { hours: hoursAsked }),
        ...(kind === "travel" ? { ticketId: ticket?.id ?? null, clientId: ticket ? null : f.clientId || null, billable: f.billable, ...(f.billable ? { amount: num(f.amount) } : {}) } : {}),
      };
      return entry ? api.patch<{ negative?: string[] }>(`/time/entries/${entry.id}`, body) : api.post<{ negative?: string[] }>("/time/entries", { ...body, typeId: f.typeId, ...(userId ? { userId } : {}) });
    },
    onSuccess: (r) => {
      onDone();
      if (r?.negative?.length) toast.warning(t("timesheet.negative"));
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const valid =
    Boolean(f.typeId) &&
    (kind === "workday" ? workdayOk && bankAsked >= 0 && bankAsked <= span / 60 : kind === "holiday" ? true : hoursAsked > 0 && hoursAsked <= 24) &&
    (kind !== "travel" || !f.billable || (num(f.amount) > 0 && Boolean(ticket || f.clientId)));
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {entry ? <Pencil className="size-5 text-primary" /> : <Plus className="size-5 text-primary" />} {entry ? `${t("timesheet.change")} — ${entry.type}` : t("timesheet.add")}
          </DialogTitle>
          <DialogDescription>{entry ? t("timesheet.changeHint") : t("timesheet.addHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <Select value={f.date} onValueChange={(v) => setF({ ...f, date: v })}>
            <SelectTrigger className="w-full" aria-label={t("timesheet.day")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {days.map((d) => (
                <SelectItem key={d} value={d} className="capitalize">
                  {dayName(d)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={f.typeId} onValueChange={(v) => setF({ ...f, typeId: v })} disabled={Boolean(entry)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("timesheet.type")} />
            </SelectTrigger>
            <SelectContent>
              {manual.map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {x.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {kind === "workday" && (
            <div className="space-y-3 rounded-xl border border-amber-400/25 bg-amber-500/[0.05] p-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1 text-xs text-muted-foreground">
                  {t("timesheet.startTime")}
                  <Input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} className="text-foreground" />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  {t("timesheet.endTime")}
                  <Input type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} className="text-foreground" />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">{t("timesheet.lunchRule")}</p>
              <p className={cn("text-sm", workdayOk ? "text-foreground" : "text-destructive")}>{workdayOk ? t("timesheet.workdayTotal", { hours: (span / 60).toLocaleString(undefined, { maximumFractionDigits: 2 }) }) : t("timesheet.workdayTimes")}</p>
              <label className="block space-y-1 rounded-lg border border-sky-400/25 bg-sky-500/[0.05] p-2.5 text-xs">
                <span className="flex items-center gap-1.5 font-medium text-sky-300">
                  <PiggyBank className="size-3.5" /> {t("timesheet.bankHours")}
                </span>
                <Input value={f.bank} inputMode="decimal" placeholder="0" onChange={(e) => setF({ ...f, bank: e.target.value })} className="font-mono" />
                <span className="block text-muted-foreground">{workdayOk && bankAsked > span / 60 ? t("timesheet.bankTooLarge") : t("timesheet.bankHoursHint")}</span>
              </label>
            </div>
          )}
          {kind === "holiday" && <p className="rounded-xl border border-violet-400/25 bg-violet-500/[0.05] p-3 text-xs text-muted-foreground">{t("timesheet.holidayHint")}</p>}
          {kind && kind !== "workday" && kind !== "holiday" && <Input required inputMode="decimal" placeholder={t("timesheet.hours")} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} className="font-mono" />}

          {kind === "travel" && (
            <div className="space-y-3 rounded-xl border bg-card/40 p-3">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">{t("timesheet.travelTicket")}</span>
                {ticket ? (
                  <div className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
                    <span className="font-mono text-[10px] text-muted-foreground">{ticket.number}</span>
                    <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
                    <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setTicket(null)}>
                      ✕
                    </button>
                  </div>
                ) : (
                  <TicketSearch autoFocus={false} onPick={setTicket} />
                )}
              </div>
              {!ticket && (
                <label className="block space-y-1 text-xs">
                  <span className="text-muted-foreground">{t("timesheet.travelClient")}</span>
                  <select value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm">
                    <option value="">{t("timesheet.noClient")}</option>
                    {(clients ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={f.billable} onCheckedChange={(v) => setF({ ...f, billable: v })} /> {t("timesheet.travelBillable")}
              </label>
              {f.billable && (
                <label className="block space-y-1 text-xs">
                  <span className="text-muted-foreground">{t("timesheet.travelAmount")}</span>
                  <Input value={f.amount} inputMode="decimal" onChange={(e) => setF({ ...f, amount: e.target.value })} className="font-mono" />
                  {!(ticket || f.clientId) && <span className="block text-destructive">{t("timesheet.travelClientRequired")}</span>}
                </label>
              )}
            </div>
          )}
          <Input placeholder={t("timesheet.note")} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <Button type="submit" className="w-full bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" disabled={!valid || save.isPending}>
            {save.isPending ? <Loader2 className="size-4 animate-spin" /> : entry ? <Pencil className="size-4" /> : <Plus className="size-4" />} {entry ? t("common.save") : t("timesheet.addButton")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The week's report, short and easy to read: compact (a line per day: the work day, the time entered, the hours paid, and the
 * paid hours by kind) or detailed (every entry of every day).
 */
function ReportDialog({
  open,
  onOpenChange,
  week,
  days,
  dayName,
  hours,
  personName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  week: Week;
  days: string[];
  dayName: (d: string) => string;
  hours: (n: number) => string;
  personName: string;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"compact" | "detailed">("compact");
  const perDay = useMemo(
    () =>
      days.map((d) => {
        const list = week.entries.filter((e) => e.date === d);
        return {
          d,
          list,
          workday: list.filter((e) => e.kind === "workday").reduce((x, e) => x + e.hours, 0),
          entered: list.filter(isEntered).reduce((x, e) => x + e.hours, 0),
          paid: list.reduce((x, e) => x + paidOf(e), 0),
        };
      }),
    [days, week.entries],
  );
  const p = week.pay;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BarChart3 className="size-5 text-primary" /> {t("timesheet.reportTitle")}
          </DialogTitle>
          <DialogDescription>
            {personName} · {new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long" }).format(new Date(`${week.weekStart}T12:00:00`))} → {new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${week.weekEnd}T12:00:00`))}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-1 rounded-lg border p-0.5 text-xs" role="tablist">
          {(["compact", "detailed"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cn("rounded-md px-2 py-1.5 font-medium", mode === m ? "bg-grad-gold text-[#1a1204]" : "text-muted-foreground hover:text-foreground")}>
              {t(`timesheet.reportMode.${m}`)}
            </button>
          ))}
        </div>

        {mode === "compact" ? (
          <div className="space-y-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 font-medium">{t("timesheet.day")}</th>
                  <th className="py-1.5 text-right font-medium">{t("timesheet.workday")}</th>
                  <th className="py-1.5 text-right font-medium">{t("timesheet.entered")}</th>
                  <th className="py-1.5 text-right font-medium">{t("timesheet.paidDay")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {perDay.map((r) => (
                  <tr key={r.d} className={cn(!r.list.length && "text-muted-foreground/60")}>
                    <td className="py-1.5 capitalize">{dayName(r.d)}</td>
                    <td className="py-1.5 text-right font-mono">{r.workday ? hours(r.workday) : "—"}</td>
                    <td className="py-1.5 text-right font-mono">{r.entered ? hours(r.entered) : "—"}</td>
                    <td className="py-1.5 text-right font-mono">{r.paid ? hours(r.paid) : "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-semibold">
                  <td className="py-2">{t("timesheet.weekTotal")}</td>
                  <td className="py-2 text-right font-mono">{hours(p.workdayHours)}</td>
                  <td className="py-2 text-right font-mono">{hours(week.enteredHours)}</td>
                  <td className="py-2 text-right font-mono">{hours(p.paidHours)}</td>
                </tr>
              </tfoot>
            </table>

            <div className="rounded-xl border bg-card/50 p-3">
              <div className={cn("grid gap-3 text-center", p.bankedHours > 0 ? "grid-cols-3" : "grid-cols-2")}>
                <Stat label={t("timesheet.workdays")} value={`${hours(p.workdayHours)} h`} />
                {p.bankedHours > 0 && <Stat label={t("timesheet.bankedWeek")} value={`${hours(p.bankedHours)} h`} tone="text-sky-300" />}
                <Stat label={t("timesheet.paidTotal")} value={`${hours(p.paidHours)} h`} tone="text-emerald-300" />
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {perDay.map((r) => (
              <section key={r.d}>
                <div className="flex items-baseline justify-between border-b pb-1">
                  <span className="text-sm font-semibold capitalize">{dayName(r.d)}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.workday > 0 && <span className="mr-3 text-amber-300">{t("timesheet.workday")} {hours(r.workday)} h</span>}
                    <span className="font-mono text-foreground">{r.paid ? `${hours(r.paid)} h` : "—"}</span>
                  </span>
                </div>
                {r.list.length > 0 && (
                  <ul className="divide-y divide-border/40 text-sm">
                    {r.list.map((e) => (
                      <li key={e.id} className="flex items-center gap-2 py-1">
                        <span className="min-w-0 flex-1 truncate">
                          {e.source === "ticket" ? (
                            <>
                              <span className="font-mono text-xs text-muted-foreground">{e.ticketNumber}</span> {e.ticketTitle}
                            </>
                          ) : e.kind === "workday" && e.startTime ? (
                            `${e.type} · ${e.startTime}–${e.endTime} · ${t("timesheet.lunchShort", { lunch: `${e.lunchMinutes ?? 0} min` })}`
                          ) : (
                            e.type
                          )}
                        </span>
                        <span className="w-16 text-right font-mono">{hours(e.hours)} h</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card/50 p-3 text-sm">
              <span className="font-semibold">{t("timesheet.weekTotal")}</span>
              <span className="font-mono">
                {hours(p.paidHours)} h {t("timesheet.paidDay").toLowerCase()}
              </span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <p className={cn("font-mono text-lg font-semibold", tone)}>{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}
