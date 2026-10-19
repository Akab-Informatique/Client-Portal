import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Clock, Loader2, Plus, Send, Ticket, Trash2, UserCog } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";

export type TimeType = { id: string; name: string; kind: "labour" | "other"; active: boolean };
type Entry = {
  id: string;
  date: string;
  typeId: string;
  type: string;
  kind: string;
  hours: number;
  note: string | null;
  ticketId: number | null;
  ticketNumber: string | null;
  ticketTitle: string | null;
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
  types: { type: string; kind: string; hours: number }[];
  labourHours: number;
  totalHours: number;
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

/**
 * My tools › Timesheet: the week. Time logged on tickets is already there
 * (with the ticket); other hours are added by type; then the week is sent
 * for approval.
 */
export function TimesheetPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  // managers pick whose timesheet (their own by default)
  const manager = useCan()("timesheets.manage");
  const [who, setWho] = useState(me.id);
  const others = who !== me.id;
  const { data: people } = useQuery({ queryKey: ["time", "people"], queryFn: () => api.get<Person[]>("/time/people"), enabled: manager });
  const [start, setStart] = useState<string | null>(null);
  const q = new URLSearchParams({ ...(start ? { start } : {}), ...(others ? { userId: who } : {}) }).toString();
  const { data: week, isLoading } = useQuery({ queryKey: ["time", "week", who, start], queryFn: () => api.get<Week>(`/time/week${q ? `?${q}` : ""}`) });
  const person = people?.find((x) => x.id === who);
  const { data: types } = useQuery({ queryKey: ["time", "types"], queryFn: () => api.get<{ time: TimeType[] }>("/time/types") });
  const manualTypes = (types?.time ?? []).filter((x) => x.kind !== "labour");
  const editable = week?.status === "draft" || week?.status === "rejected";
  const [f, setF] = useState({ date: "", typeId: "", hours: "", note: "" });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["time", "week"] });
  const add = useMutation({
    mutationFn: () =>
      api.post("/time/entries", {
        date: f.date || week!.weekStart,
        typeId: f.typeId,
        hours: Number(f.hours.replace(",", ".")),
        note: f.note || undefined,
        ...(others ? { userId: who } : {}),
      }),
    onSuccess: () => {
      refresh();
      setF({ ...f, hours: "", note: "" });
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "timesheet_locked" ? t("timesheet.locked") : t("common.error")),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/time/entries/${id}`), onSuccess: refresh });
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
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-3">
            {days.map((d) => {
              const list = week.entries.filter((e) => e.date === d);
              const total = list.reduce((x, e) => x + e.hours, 0);
              return (
                <section key={d} className={cn("glass rounded-2xl border", !list.length && "opacity-70")}>
                  <div className="flex items-center justify-between border-b px-4 py-2">
                    <span className="text-sm font-semibold capitalize">{dayName(d)}</span>
                    <span className="font-mono text-sm">{total ? `${hours(total)} h` : "—"}</span>
                  </div>
                  {list.length > 0 && (
                    <ul className="divide-y divide-border/60">
                      {list.map((e) => (
                        <li key={e.id} className="group flex items-start gap-3 px-4 py-2 text-sm">
                          {e.source === "ticket" ? (
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
                            {e.note && <span className="block text-xs text-muted-foreground">{e.note}</span>}
                          </span>
                          <span className="font-mono">{hours(e.hours)} h</span>
                          {e.source === "manual" && editable && (
                            <button
                              type="button"
                              onClick={() => remove.mutate(e.id)}
                              className="rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                              aria-label={t("timesheet.remove")}
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          )}
                        </li>
                      ))}
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
              {week.status === "rejected" && week.comment && (
                <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200">{week.comment}</p>
              )}
              <ul className="space-y-1 text-sm">
                {week.types.map((x) => (
                  <li key={x.type} className="flex justify-between">
                    <span className={cn(x.kind === "labour" && "font-medium")}>{x.type}</span>
                    <span className="font-mono">{hours(x.hours)} h</span>
                  </li>
                ))}
                {!week.types.length && <li className="text-xs text-muted-foreground">{t("timesheet.empty")}</li>}
              </ul>
              <div className="flex justify-between border-t pt-2 text-sm font-semibold">
                <span>{t("timesheet.total")}</span>
                <span className="font-mono">{hours(week.totalHours)} h</span>
              </div>
              {!week.required && <p className="rounded-lg border bg-background/40 p-2 text-xs text-muted-foreground">{t("timesheet.notRequired")}</p>}
              {editable && week.required && week.entries.length > 0 && <p className="text-[11px] text-amber-300">{t("timesheet.toSubmit")}</p>}
              {editable && week.required && (
                <Button
                  className="w-full bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105"
                  disabled={submit.isPending || !week.entries.length}
                  onClick={() => submit.mutate()}
                >
                  {submit.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("timesheet.submit")}
                </Button>
              )}
            </section>

            {editable && (
              <form
                className="glass space-y-2 rounded-2xl border p-4"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  add.mutate();
                }}
              >
                <p className="text-sm font-semibold">{t("timesheet.add")}</p>
                <p className="text-[11px] text-muted-foreground">{t("timesheet.addHint")}</p>
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
                    {manualTypes.map((x) => (
                      <SelectItem key={x.id} value={x.id}>
                        {x.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  required
                  inputMode="decimal"
                  placeholder={t("timesheet.hours")}
                  value={f.hours}
                  onChange={(e) => setF({ ...f, hours: e.target.value })}
                />
                <Input placeholder={t("timesheet.note")} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
                <Button type="submit" variant="outline" className="w-full" disabled={!f.typeId || !f.hours || add.isPending}>
                  <Plus className="size-4" /> {t("timesheet.addButton")}
                </Button>
              </form>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
