import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { holidaysBetween } from "@shared/holidays";

const KINDS = ["vacation", "sick", "training", "personal", "other"] as const;
type Kind = (typeof KINDS)[number];
type Absence = { id: string; userId: string; name: string; startDate: string; endDate: string; kind: Kind; note: string | null };
type Draft = { id?: string; userId: string; startDate: string; endDate: string; kind: Kind; note: string };

const KIND_STYLE: Record<Kind, string> = {
  vacation: "bg-sky-500/20 text-sky-200 border-sky-500/40",
  sick: "bg-red-500/20 text-red-200 border-red-500/40",
  training: "bg-violet-500/20 text-violet-200 border-violet-500/40",
  personal: "bg-amber-500/20 text-amber-200 border-amber-500/40",
  other: "bg-slate-500/20 text-slate-200 border-slate-500/40",
};
/** Weekends: their own cool tint (teal is not used by any absence kind) */
const WEEKEND_CELL = "bg-teal-400/[0.07]";
const WEEKEND_HEAD = "bg-teal-400/[0.07] text-teal-300/90";

const KIND_DOT: Record<Kind, string> = { vacation: "bg-sky-400", sick: "bg-red-400", training: "bg-violet-400", personal: "bg-amber-400", other: "bg-slate-400" };

/** Local calendar day as YYYY-MM-DD */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const loc = () => (currentLocale() === "en" ? "en-CA" : "fr-CA");

/** Weeks (Sunday first, Saturday last) covering the month */
function monthGrid(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = addDays(first, -first.getDay());
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const end = addDays(last, 6 - last.getDay());
  const days: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return { days, from: ymd(start), to: ymd(end) };
}

/** Weekly meeting: team absences on a month calendar. */
export function AbsencesSection() {
  const { t } = useTranslation();
  const manage = useCan()("meetings.manage");
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [draft, setDraft] = useState<Draft | null>(null);
  const grid = useMemo(() => monthGrid(month), [month]);
  const today = ymd(new Date());
  const { data } = useQuery({
    queryKey: ["meetings", "absences", grid.from, grid.to],
    queryFn: () => api.get<Absence[]>(`/meetings/absences?from=${grid.from}&to=${grid.to}`),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });
  const absences = data ?? [];
  const holidays = useMemo(() => holidaysBetween(grid.from, grid.to), [grid]);
  const weekdays = useMemo(() => grid.days.slice(0, 7).map((d) => new Intl.DateTimeFormat(loc(), { weekday: "short" }).format(d)), [grid]);
  const title = new Intl.DateTimeFormat(loc(), { month: "long", year: "numeric" }).format(month);

  const blank = (day: string): Draft => ({ userId: "", startDate: day, endDate: day, kind: "vacation", note: "" });
  const open = (a: Absence) => setDraft({ id: a.id, userId: a.userId, startDate: a.startDate, endDate: a.endDate, kind: a.kind, note: a.note ?? "" });

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <CalendarDays className="size-5 text-primary" /> {t("meetings.absences.title")}
        </h2>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label={t("meetings.absences.previous")}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-36 text-center text-sm font-medium capitalize">{title}</span>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label={t("meetings.absences.next")}>
            <ChevronRight className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
            {t("meetings.absences.today")}
          </Button>
          {manage && (
            <Button size="sm" className="ml-1" onClick={() => setDraft(blank(today))}>
              <Plus className="size-4" /> {t("meetings.absences.add")}
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-card/80">
        <div className="grid grid-cols-7 border-b text-center text-xs font-medium uppercase text-muted-foreground">
          {weekdays.map((w, i) => (
            <div key={w} className={cn("py-2", (i === 0 || i === 6) && WEEKEND_HEAD)}>
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.days.map((d, i) => {
            const day = ymd(d);
            const inMonth = d.getMonth() === month.getMonth();
            const weekend = d.getDay() === 0 || d.getDay() === 6;
            const here = absences.filter((a) => a.startDate <= day && a.endDate >= day);
            const holiday = holidays.get(day);
            return (
              <div
                key={day}
                className={cn(
                  "min-h-24 border-b border-r p-1 sm:p-1.5",
                  (i + 1) % 7 === 0 && "border-r-0",
                  i >= grid.days.length - 7 && "border-b-0",
                  weekend ? WEEKEND_CELL : !inMonth && "bg-muted/20",
                  holiday && "bg-[color:var(--gold)]/[0.06]",
                  manage && "cursor-pointer hover:bg-accent/30",
                )}
                onClick={() => manage && setDraft(blank(day))}
              >
                <div
                  className={cn(
                    "mb-1 flex size-6 items-center justify-center rounded-full text-xs",
                    !inMonth ? "text-muted-foreground/50" : weekend && "text-teal-200/90",
                    day === today && "bg-primary font-semibold text-primary-foreground",
                  )}
                >
                  {d.getDate()}
                </div>
                <div className="space-y-0.5">
                  {holiday && (
                    <span
                      title={t(`meetings.absences.holiday.${holiday}`)}
                      className={cn("block truncate rounded border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/15 px-1 py-px text-[11px] leading-4 text-primary", !inMonth && "opacity-50")}
                    >
                      {t(`meetings.absences.holiday.${holiday}`)}
                    </span>
                  )}
                  {here.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      title={[a.name, t(`meetings.absences.kind.${a.kind}`), a.note].filter(Boolean).join(" · ")}
                      className={cn("block w-full truncate rounded border px-1 py-px text-left text-[11px] leading-4", KIND_STYLE[a.kind], !manage && "cursor-default")}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (manage) open(a);
                      }}
                    >
                      {a.name}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-[color:var(--gold)]" /> {t("meetings.absences.holidayLegend")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-teal-400/70" /> {t("meetings.absences.weekend")}
        </span>
        {KINDS.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", KIND_DOT[k])} /> {t(`meetings.absences.kind.${k}`)}
          </span>
        ))}
      </div>

      {draft && <AbsenceDialog draft={draft} onClose={() => setDraft(null)} />}
    </section>
  );
}

function AbsenceDialog({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [d, setD] = useState(draft);
  const team = useQuery({ queryKey: ["meetings", "team"], queryFn: () => api.get<{ id: string; name: string }[]>("/meetings/team"), staleTime: 5 * 60_000 });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["meetings", "absences"] });
    onClose();
  };
  const onError = (e: unknown) => toast.error(e instanceof ApiError && e.fields?.some((f) => f.message === "end_before_start") ? t("meetings.absences.endBeforeStart") : t("common.error"));
  const save = useMutation({
    mutationFn: () => {
      const payload = { userId: d.userId, startDate: d.startDate, endDate: d.endDate, kind: d.kind, note: d.note };
      return d.id ? api.put(`/meetings/absences/${d.id}`, payload) : api.post("/meetings/absences", payload);
    },
    onSuccess: done,
    onError,
  });
  const remove = useMutation({ mutationFn: () => api.del(`/meetings/absences/${d.id}`), onSuccess: done, onError });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (d.userId && d.startDate && d.endDate) save.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(d.id ? "meetings.absences.editTitle" : "meetings.absences.addTitle")}</DialogTitle>
          <DialogDescription>{t("meetings.absences.dialogText")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("meetings.absences.person")}</Label>
            <Select value={d.userId} onValueChange={(userId) => setD({ ...d, userId })}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("meetings.absences.choosePerson")} />
              </SelectTrigger>
              <SelectContent>
                {(team.data ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="abs-from">{t("meetings.absences.from")}</Label>
              <Input id="abs-from" type="date" required value={d.startDate} onChange={(e) => setD({ ...d, startDate: e.target.value, endDate: d.endDate < e.target.value ? e.target.value : d.endDate })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="abs-to">{t("meetings.absences.to")}</Label>
              <Input id="abs-to" type="date" required min={d.startDate} value={d.endDate} onChange={(e) => setD({ ...d, endDate: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("meetings.absences.type")}</Label>
            <Select value={d.kind} onValueChange={(kind) => setD({ ...d, kind: kind as Kind })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    <span className={cn("size-2 rounded-full", KIND_DOT[k])} /> {t(`meetings.absences.kind.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="abs-note">{t("meetings.absences.note")}</Label>
            <Input id="abs-note" maxLength={300} placeholder={t("meetings.absences.notePlaceholder")} value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} />
          </div>
          <div className="flex items-center gap-2 pt-2">
            {d.id && (
              <Button
                type="button"
                variant="ghost"
                className="text-red-400"
                onClick={() => void confirm({ title: t("meetings.absences.deleteConfirm"), destructive: true }).then((ok) => ok && remove.mutate())}
              >
                <Trash2 className="size-4" /> {t("common.delete")}
              </Button>
            )}
            <Button type="button" variant="ghost" className="ml-auto" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!d.userId || save.isPending}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
