import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BarChart3, ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, Clock, Loader2, PiggyBank, Plus, Send, Sun, Ticket, Trash2, UserCog } from "lucide-react";
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

export type TimeType = { id: string; name: string; kind: "labour" | "workday" | "bankpay" | "other"; active: boolean; billable: boolean };
type Entry = {
  id: string;
  date: string;
  typeId: string;
  type: string;
  kind: string;
  hours: number;
  /** The hours of it that count as billable time */
  billableHours: number;
  note: string | null;
  ticketId: number | null;
  ticketNumber: string | null;
  ticketTitle: string | null;
  startTime: string | null;
  endTime: string | null;
  lunchMinutes: number | null;
  /** Banked instead of paid */
  banked: boolean;
  source: "ticket" | "manual";
};
type Person = { id: string; name: string; email: string; timesheetRequired: boolean };
type Week = {
  userId: string;
  required: boolean;
  weekStart: string;
  weekEnd: string;
  status: "draft" | "submitted" | "approved" | "rejected" | "paid";
  comment: string | null;
  entries: Entry[];
  types: { type: string; kind: string; hours: number; billableHours: number }[];
  labourHours: number;
  labourBilledHours: number;
  /** The hours worked: every type but the work day */
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  billableRatio: number | null;
  workdayHours: number;
  /** Hours banked instead of paid (part of the hours worked) */
  bankedHours: number;
  /** Hours paid out of the bank this week (not hours worked) */
  bankPaidHours: number;
  /** What the bank holds: every hour banked, less the ones paid out of it */
  bankBalanceHours: number;
};

const STATUS_STYLE: Record<Week["status"], string> = {
  draft: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  submitted: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  approved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  rejected: "border-red-500/40 bg-red-500/10 text-red-300",
  paid: "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary",
};
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const minutesOf = (t: string) => (t.length >= 5 ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : NaN);

/** Billed / not billed, on an entry. */
function BillTag({ e }: { e: Entry }) {
  const { t } = useTranslation();
  if (e.kind === "workday" || e.kind === "bankpay") return null;
  const full = e.billableHours >= e.hours - 0.001;
  const none = e.billableHours <= 0.001;
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium",
        none ? "border-border text-muted-foreground" : full ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300" : "border-amber-400/40 bg-amber-500/10 text-amber-300",
      )}
    >
      {none ? t("timesheet.notBilled") : full ? t("timesheet.billed") : t("timesheet.partlyBilled")}
    </span>
  );
}

/** Banked instead of paid. */
function BankTag() {
  const { t } = useTranslation();
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full border border-sky-400/40 bg-sky-500/10 px-1.5 py-px text-[10px] font-medium text-sky-300">
      <PiggyBank className="size-2.5" /> {t("timesheet.bankTag")}
    </span>
  );
}

/**
 * My tools › Timesheet: the week. Time logged on tickets is already there
 * (with the ticket; a click opens it); other hours are added by type, the
 * work day with its start, end and lunch; then the week is sent for approval.
 * The side shows the hours per type, the time worked (the work day is not
 * counted in it) and how much of it is billable.
 */
export function TimesheetPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const can = useCan();
  const ws = useTicketWorkspace();
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
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const [report, setReport] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["time", "week"] });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/time/entries/${id}`),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof ApiError && e.code === "bank_in_use" ? t("timesheet.bankInUse") : t("common.error")),
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
  const workdays = week?.entries.filter((e) => e.kind === "workday") ?? [];
  const allClosed = days.length > 0 && days.every((d) => closed[d]);

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
          {editable && (
            <Button className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> {t("timesheet.addEntry")}
            </Button>
          )}
          <Button variant="outline" onClick={() => setReport(true)}>
            <BarChart3 className="size-4" /> {t("timesheet.report")}
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto gap-1.5 text-muted-foreground" onClick={() => setClosed(allClosed ? {} : Object.fromEntries(days.map((d) => [d, true])))}>
            {allClosed ? <ChevronsUpDown className="size-4" /> : <ChevronsDownUp className="size-4" />} {allClosed ? t("timesheet.expandAll") : t("timesheet.collapseAll")}
          </Button>
        </div>
      )}
      {week && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-3">
            {days.map((d) => {
              const list = week.entries.filter((e) => e.date === d);
              const worked = list.filter((e) => e.kind !== "workday" && e.kind !== "bankpay").reduce((x, e) => x + e.hours, 0);
              const wd = list.filter((e) => e.kind === "workday").reduce((x, e) => x + e.hours, 0);
              const paidFromBank = list.filter((e) => e.kind === "bankpay").reduce((x, e) => x + e.hours, 0);
              const isClosed = Boolean(closed[d]);
              return (
                <section key={d} className={cn("glass rounded-2xl border", !list.length && "opacity-70")}>
                  <button type="button" aria-expanded={!isClosed} onClick={() => setClosed((c) => ({ ...c, [d]: !c[d] }))} className="flex w-full items-center gap-3 px-4 py-2 text-left">
                    <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", isClosed && "-rotate-90")} />
                    <span className="flex-1 text-sm font-semibold capitalize">{dayName(d)}</span>
                    {wd > 0 && (
                      <span className="flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-px text-[11px] text-amber-300" title={t("timesheet.workday")}>
                        <Sun className="size-3" /> {hours(wd)} h
                      </span>
                    )}
                    {paidFromBank > 0 && (
                      <span className="flex items-center gap-1 rounded-full border border-sky-400/30 bg-sky-500/10 px-2 py-px text-[11px] text-sky-300" title={t("timesheet.bankPay")}>
                        <PiggyBank className="size-3" /> −{hours(paidFromBank)} h
                      </span>
                    )}
                    <span className="font-mono text-sm">{worked ? `${hours(worked)} h` : "—"}</span>
                  </button>
                  {!isClosed && list.length > 0 && (
                    <ul className="divide-y divide-border/60 border-t">
                      {list.map((e) => {
                        const openTicket = e.source === "ticket" && e.ticketId != null && can("tickets.view");
                        const body = (
                          <>
                            {e.kind === "workday" ? (
                              <Sun className="mt-0.5 size-4 shrink-0 text-amber-300" />
                            ) : e.kind === "bankpay" ? (
                              <PiggyBank className="mt-0.5 size-4 shrink-0 text-sky-300" />
                            ) : e.source === "ticket" ? (
                              <Ticket className="mt-0.5 size-4 shrink-0 text-primary" />
                            ) : (
                              <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block">
                                {e.source === "ticket" ? (
                                  <>
                                    <span className="font-mono text-xs text-muted-foreground">{e.ticketNumber}</span> {e.ticketTitle}
                                  </>
                                ) : (
                                  e.type
                                )}
                              </span>
                              {e.kind === "workday" && e.startTime && e.endTime && (
                                <span className="block text-xs text-muted-foreground">{t("timesheet.workdayLine", { from: e.startTime, to: e.endTime, lunch: `${e.lunchMinutes ?? 0} min` })}</span>
                              )}
                              {e.note && <span className="block text-xs text-muted-foreground">{e.note}</span>}
                            </span>
                            {e.banked && <BankTag />}
                            <BillTag e={e} />
                            <span className="font-mono">{hours(e.hours)} h</span>
                          </>
                        );
                        return (
                          <li key={e.id} className="group flex items-start gap-2 px-4 py-2 text-sm">
                            {openTicket ? (
                              <button type="button" title={t("timesheet.openTicket")} onClick={() => ws.open(e.ticketId!)} className="-mx-2 flex min-w-0 flex-1 items-start gap-3 rounded-lg px-2 py-0.5 text-left transition hover:bg-accent/50">
                                {body}
                              </button>
                            ) : (
                              <div className="flex min-w-0 flex-1 items-start gap-3">{body}</div>
                            )}
                            {e.source === "manual" && editable && (
                              <button type="button" onClick={() => remove.mutate(e.id)} className="rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100" aria-label={t("timesheet.remove")}>
                                <Trash2 className="size-3.5" />
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
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

              {/* the work days: apart, not part of the hours worked */}
              <div className="rounded-xl border border-amber-400/25 bg-amber-500/[0.06] p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Sun className="size-3.5 text-amber-300" /> {t("timesheet.workdays")}
                  </span>
                  <span className="font-mono">{hours(week.workdayHours)} h</span>
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
                <p className="mt-1.5 text-[10px] text-muted-foreground">{t("timesheet.workdayNote")}</p>
              </div>

              {/* hours per type: ticket time split into billed and not billed */}
              <ul className="space-y-1 text-sm">
                {week.types.flatMap((x) =>
                  x.kind === "labour"
                    ? [
                        { key: `${x.type}-b`, label: `${x.type} · ${t("timesheet.billed").toLowerCase()}`, hours: x.billableHours, on: true, bold: true },
                        { key: `${x.type}-n`, label: `${x.type} · ${t("timesheet.notBilled").toLowerCase()}`, hours: x.hours - x.billableHours, on: false, bold: true },
                      ]
                    : [{ key: x.type, label: x.type, hours: x.hours, on: x.billableHours > 0, bold: false }],
                ).map((r) => (
                  <li key={r.key} className="flex items-center justify-between gap-2">
                    <span className={cn("flex min-w-0 items-center gap-1.5", r.bold && "font-medium")}>
                      <span className={cn("size-1.5 shrink-0 rounded-full", r.on ? "bg-emerald-400" : "bg-muted-foreground/40")} />
                      <span className="truncate">{r.label}</span>
                    </span>
                    <span className="font-mono">{hours(r.hours)} h</span>
                  </li>
                ))}
                {!week.types.length && <li className="text-xs text-muted-foreground">{t("timesheet.empty")}</li>}
              </ul>

              {/* the totals: what was worked, what of it is billable, and the ratio */}
              <div className="space-y-1.5 border-t pt-2 text-sm">
                <div className="flex justify-between font-semibold">
                  <span>{t("timesheet.worked")}</span>
                  <span className="font-mono">{hours(week.totalHours)} h</span>
                </div>
                <div className="flex justify-between text-emerald-300">
                  <span>{t("timesheet.billable")}</span>
                  <span className="font-mono">{hours(week.billableHours)} h</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>{t("timesheet.nonBillable")}</span>
                  <span className="font-mono">{hours(week.nonBillableHours)} h</span>
                </div>
                <Ratio worked={week.totalHours} billable={week.billableHours} ratio={week.billableRatio} label={t("timesheet.ratio")} />
              </div>

              {/* the hours bank: what it holds, what went in and what was paid out of it this week */}
              <div className="space-y-1 rounded-xl border border-sky-400/25 bg-sky-500/[0.06] p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 font-medium text-sky-300">
                    <PiggyBank className="size-3.5" /> {t("timesheet.bankBalance")}
                  </span>
                  <span className="font-mono font-semibold">{hours(week.bankBalanceHours)} h</span>
                </div>
                {week.bankedHours > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{t("timesheet.bankedWeek")}</span>
                    <span className="font-mono text-sky-300">+{hours(week.bankedHours)} h</span>
                  </div>
                )}
                {week.bankPaidHours > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{t("timesheet.bankPaidWeek")}</span>
                    <span className="font-mono text-sky-300">−{hours(week.bankPaidHours)} h</span>
                  </div>
                )}
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

      {week && editable && <EntryDialog open={adding} onOpenChange={setAdding} week={week} days={days} dayName={dayName} userId={others ? who : null} onDone={refresh} />}
      {week && <ReportDialog open={report} onOpenChange={setReport} week={week} days={days} dayName={dayName} hours={hours} personName={others && person ? person.name : me.name} />}
    </div>
  );
}

/** Billable time over the time worked: a bar and a percentage. */
function Ratio({ worked, billable, ratio, label }: { worked: number; billable: number; ratio: number | null; label: string }) {
  return (
    <div className="space-y-1 pt-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono text-sm font-semibold text-foreground">{ratio === null ? "—" : `${ratio.toLocaleString(undefined, { maximumFractionDigits: 1 })} %`}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted/60" role="progressbar" aria-valuenow={ratio ?? 0} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-300 transition-all" style={{ width: `${worked ? Math.min(100, (billable / worked) * 100) : 0}%` }} />
      </div>
    </div>
  );
}

/** "Add a time entry": a centered window over the page. The work day takes its start, end and lunch. */
function EntryDialog({
  open,
  onOpenChange,
  week,
  days,
  dayName,
  userId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  week: Week;
  days: string[];
  dayName: (d: string) => string;
  userId: string | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const me = useMe();
  const { data: types } = useQuery({ queryKey: ["time", "types"], queryFn: () => api.get<{ time: TimeType[] }>("/time/types") });
  // banked instead of paid: what the profile says, for each entry
  const [banked, setBanked] = useState<boolean | null>(null);
  const bankOn = banked ?? me.preferences.bankHours;
  const manual = (types?.time ?? []).filter((x) => x.kind !== "labour");
  const [f, setF] = useState({ date: "", typeId: "", hours: "", note: "", start: "08:00", end: "16:30" });
  const type = manual.find((x) => x.id === f.typeId);
  const isWorkday = type?.kind === "workday";
  const isBankPay = type?.kind === "bankpay";
  const hoursAsked = Number(f.hours.replace(",", "."));
  const span = minutesOf(f.end) - minutesOf(f.start) - unpaidLunch(minutesOf(f.start), minutesOf(f.end));
  const workdayOk = Number.isFinite(span) && span > 0 && span <= 24 * 60;
  const add = useMutation({
    mutationFn: () =>
      api.post("/time/entries", {
        date: f.date || week.weekStart,
        typeId: f.typeId,
        note: f.note || undefined,
        ...(isWorkday ? { start: f.start, end: f.end } : { hours: hoursAsked, ...(isBankPay ? {} : { banked: bankOn }) }),
        ...(userId ? { userId } : {}),
      }),
    onSuccess: () => {
      onDone();
      setF((x) => ({ ...x, hours: "", note: "" }));
      setBanked(null);
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "timesheet_locked" ? t("timesheet.locked") : e instanceof ApiError && e.code === "workday_exists" ? t("timesheet.workdayExists") : e instanceof ApiError && e.code === "workday_times" ? t("timesheet.workdayTimes") : e instanceof ApiError && e.code === "bank_insufficient" ? t("timesheet.bankInsufficient") : t("common.error")),
  });
  const overBank = isBankPay && hoursAsked > week.bankBalanceHours + 0.001;
  const valid = f.typeId && (isWorkday ? workdayOk : hoursAsked > 0 && !overBank);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="size-5 text-primary" /> {t("timesheet.add")}
          </DialogTitle>
          <DialogDescription>{t("timesheet.addHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid) add.mutate();
          }}
        >
          <Select value={f.date || week.weekStart} onValueChange={(v) => setF({ ...f, date: v })}>
            <SelectTrigger className="w-full">
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
          <Select value={f.typeId} onValueChange={(v) => setF({ ...f, typeId: v })}>
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
          {isWorkday ? (
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
              <p className={cn("text-sm", workdayOk ? "text-foreground" : "text-destructive")}>
                {workdayOk ? t("timesheet.workdayTotal", { hours: (span / 60).toLocaleString(undefined, { maximumFractionDigits: 2 }) }) : t("timesheet.workdayTimes")}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Input required inputMode="decimal" placeholder={t("timesheet.hours")} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} />
              {isBankPay && (
                <p className={cn("flex items-center gap-1.5 text-xs", overBank ? "text-destructive" : "text-sky-300")}>
                  <PiggyBank className="size-3.5" /> {overBank ? t("timesheet.bankInsufficient") : t("timesheet.bankAvailable", { hours: week.bankBalanceHours.toLocaleString(undefined, { maximumFractionDigits: 2 }) })}
                </p>
              )}
            </div>
          )}
          <Input placeholder={t("timesheet.note")} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          {!isWorkday && !isBankPay && (
            <label className="flex items-center justify-between gap-3 rounded-lg border border-sky-400/25 bg-sky-500/[0.05] p-3 text-sm">
              <span className="space-y-0.5">
                <span className="flex items-center gap-1.5 font-medium">
                  <PiggyBank className="size-4 text-sky-300" /> {t("timesheet.bankEntry")}
                </span>
                <span className="block text-xs text-muted-foreground">{t("timesheet.bankEntryHint")}</span>
              </span>
              <Switch checked={bankOn} onCheckedChange={setBanked} aria-label={t("timesheet.bankEntry")} />
            </label>
          )}
          <Button type="submit" className="w-full bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" disabled={!valid || add.isPending}>
            {add.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {t("timesheet.addButton")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The week's report, short and easy to read: compact (a line per day, the totals
 * by type and the billable ratio) or detailed (every entry of every day).
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
        const work = list.filter((e) => e.kind !== "workday" && e.kind !== "bankpay");
        return {
          d,
          list,
          workday: list.filter((e) => e.kind === "workday").reduce((x, e) => x + e.hours, 0),
          worked: work.reduce((x, e) => x + e.hours, 0),
          billable: work.reduce((x, e) => x + e.billableHours, 0),
        };
      }),
    [days, week.entries],
  );
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toLocaleString(undefined, { maximumFractionDigits: 0 })} %` : "—");
  // by type: ticket time billed and not billed apart, the other types with their own mark
  const rows = week.types.flatMap((x) =>
    x.kind === "labour"
      ? [
          { key: `${x.type}-b`, label: `${x.type} · ${t("timesheet.billed").toLowerCase()}`, hours: x.billableHours, billable: true },
          { key: `${x.type}-n`, label: `${x.type} · ${t("timesheet.notBilled").toLowerCase()}`, hours: x.hours - x.billableHours, billable: false },
        ]
      : [{ key: x.type, label: x.type, hours: x.hours, billable: x.billableHours > 0 }],
  );
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
                  <th className="py-1.5 text-right font-medium">{t("timesheet.worked")}</th>
                  <th className="py-1.5 text-right font-medium">{t("timesheet.billable")}</th>
                  <th className="py-1.5 text-right font-medium">%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {perDay.map((r) => (
                  <tr key={r.d} className={cn(!r.list.length && "text-muted-foreground/60")}>
                    <td className="py-1.5 capitalize">{dayName(r.d)}</td>
                    <td className="py-1.5 text-right font-mono">{r.workday ? hours(r.workday) : "—"}</td>
                    <td className="py-1.5 text-right font-mono">{r.worked ? hours(r.worked) : "—"}</td>
                    <td className="py-1.5 text-right font-mono text-emerald-300">{r.billable ? hours(r.billable) : "—"}</td>
                    <td className="py-1.5 text-right font-mono text-muted-foreground">{pct(r.billable, r.worked)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-semibold">
                  <td className="py-2">{t("timesheet.weekTotal")}</td>
                  <td className="py-2 text-right font-mono">{hours(week.workdayHours)}</td>
                  <td className="py-2 text-right font-mono">{hours(week.totalHours)}</td>
                  <td className="py-2 text-right font-mono text-emerald-300">{hours(week.billableHours)}</td>
                  <td className="py-2 text-right font-mono">{week.billableRatio === null ? "—" : `${week.billableRatio.toLocaleString(undefined, { maximumFractionDigits: 0 })} %`}</td>
                </tr>
              </tfoot>
            </table>

            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("timesheet.byType")}</p>
              <ul className="space-y-1 text-sm">
                {rows.map((r) => (
                  <li key={r.key} className="flex items-center gap-2">
                    <span className={cn("size-1.5 shrink-0 rounded-full", r.billable ? "bg-emerald-400" : "bg-muted-foreground/40")} />
                    <span className="min-w-0 flex-1 truncate">{r.label}</span>
                    <span className="w-14 text-right text-xs text-muted-foreground">{pct(r.hours, week.totalHours)}</span>
                    <span className="w-16 text-right font-mono">{hours(r.hours)} h</span>
                    <span className={cn("w-24 text-right text-[11px]", r.billable ? "text-emerald-300" : "text-muted-foreground")}>{r.billable ? t("timesheet.billable") : t("timesheet.nonBillable")}</span>
                  </li>
                ))}
                {!rows.length && <li className="text-xs text-muted-foreground">{t("timesheet.empty")}</li>}
              </ul>
            </div>

            <div className="rounded-xl border bg-card/50 p-3">
              <div className={cn("grid gap-3 text-center", week.bankedHours > 0 ? "grid-cols-4" : "grid-cols-3")}>
                <Stat label={t("timesheet.worked")} value={`${hours(week.totalHours)} h`} />
                <Stat label={t("timesheet.billable")} value={`${hours(week.billableHours)} h`} tone="text-emerald-300" />
                <Stat label={t("timesheet.nonBillable")} value={`${hours(week.nonBillableHours)} h`} tone="text-muted-foreground" />
                {week.bankedHours > 0 && <Stat label={t("timesheet.bankedWeek")} value={`${hours(week.bankedHours)} h`} tone="text-sky-300" />}
              </div>
              <Ratio worked={week.totalHours} billable={week.billableHours} ratio={week.billableRatio} label={t("timesheet.ratio")} />
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
                    <span className="font-mono text-foreground">{r.worked ? `${hours(r.worked)} h` : "—"}</span>
                    {r.billable > 0 && <span className="ml-2 font-mono text-emerald-300">{hours(r.billable)} h {t("timesheet.billable").toLowerCase()}</span>}
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
                        <BillTag e={e} />
                        <span className="w-16 text-right font-mono">{hours(e.hours)} h</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card/50 p-3 text-sm">
              <span className="font-semibold">{t("timesheet.weekTotal")}</span>
              <span className="font-mono">{hours(week.totalHours)} h</span>
              <span className="font-mono text-emerald-300">{hours(week.billableHours)} h {t("timesheet.billable").toLowerCase()}</span>
              <span className="font-mono font-semibold">{week.billableRatio === null ? "—" : `${week.billableRatio.toLocaleString(undefined, { maximumFractionDigits: 1 })} %`}</span>
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
