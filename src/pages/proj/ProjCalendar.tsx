import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProjDetail, ProjTask } from "./shared";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Today in the local calendar (the portal is used in Québec) */
function todayYmd(): string {
  const n = new Date();
  return ymd(n.getFullYear(), n.getMonth() + 1, n.getDate());
}

/** A compact month of the project: start, due date and the due dates of its tasks. */
export function ProjCalendar({ project, onOpenTask }: { project: ProjDetail; onOpenTask: (taskId: string) => void }) {
  const { t, i18n } = useTranslation();
  const today = todayYmd();
  const [ym, setYm] = useState(() => (project.dueDate ?? today).slice(0, 7));
  const [selected, setSelected] = useState<string | null>(null);

  const [year, month] = ym.split("-").map(Number);

  const tasksByDay = useMemo(() => {
    const map = new Map<string, ProjTask[]>();
    for (const task of project.tasks) {
      if (!task.dueDate) continue;
      const list = map.get(task.dueDate) ?? [];
      list.push(task);
      map.set(task.dueDate, list);
    }
    return map;
  }, [project.tasks]);

  // Monday first: index 0 = Monday
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(i18n.language, { weekday: "narrow" }).format(new Date(2026, 0, 5 + i))), [i18n.language]);
  const monthLabel = new Intl.DateTimeFormat(i18n.language, { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));

  const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const shift = (delta: number) => {
    const d = new Date(year, month - 1 + delta, 1);
    setYm(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  };

  const dayTasks = selected ? tasksByDay.get(selected) ?? [] : [];

  return (
    <section aria-labelledby="proj-calendar-title" className="glass space-y-3 rounded-2xl border border-violet-500/25 p-4">
      <header className="flex items-center justify-between gap-2">
        <h3 id="proj-calendar-title" className="text-sm font-semibold uppercase tracking-wide text-violet-300">
          {t("proj.calendar.title")}
        </h3>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => shift(-1)} aria-label={t("proj.calendar.prev")} className="grid size-7 place-items-center rounded-md hover:bg-white/10">
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <span className="min-w-[8.5rem] text-center text-sm font-medium capitalize">{monthLabel}</span>
          <button type="button" onClick={() => shift(1)} aria-label={t("proj.calendar.next")} className="grid size-7 place-items-center rounded-md hover:bg-white/10">
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
      </header>

      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground" aria-hidden>
        {weekdays.map((w, i) => (
          <span key={i} className="py-1 uppercase">
            {w}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (d === null) return <span key={`b${i}`} />;
          const date = ymd(year, month, d);
          const tasks = tasksByDay.get(date) ?? [];
          const isDue = project.dueDate === date;
          const isToday = date === today;
          const isSel = selected === date;
          return (
            <button
              key={date}
              type="button"
              onClick={() => setSelected(date)}
              aria-pressed={isSel}
              aria-label={`${date}${tasks.length ? `, ${t("proj.calendar.tasks", { count: tasks.length })}` : ""}`}
              className={cn(
                "flex h-10 flex-col items-center justify-center rounded-lg border border-transparent text-xs tabular-nums transition hover:bg-white/10",
                isSel && "border-violet-400/60 bg-violet-500/15",
                isToday && "ring-2 ring-[color:var(--gold)]/70",
              )}
            >
              <span>{d}</span>
              <span className="flex h-2 items-center gap-0.5" aria-hidden>
                {isDue && <span className="size-1.5 rounded-full bg-red-400" />}
                {tasks.length > 0 && <span className="flex items-center gap-0.5 rounded-full bg-violet-400 px-1 text-[8px] leading-3 text-black">{tasks.length > 1 ? tasks.length : ""}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <ul className="flex flex-wrap gap-3 text-[11px] text-muted-foreground" aria-label={t("proj.calendar.title")}>
        <li className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-emerald-400" aria-hidden /> {t("proj.calendar.start")}
        </li>
        <li className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-red-400" aria-hidden /> {t("proj.calendar.due")}
        </li>
        <li className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-violet-400" aria-hidden /> {t("proj.calendar.task")}
        </li>
      </ul>

      {!selected ? (
        <p className="text-xs text-muted-foreground">{t("proj.calendar.dayHint")}</p>
      ) : (
        <div className="space-y-2 rounded-xl border border-white/10 p-3">
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground tabular-nums">{selected}</span>
            {project.dueDate === selected && <span className="text-red-300">{t("proj.calendar.due")}</span>}
          </div>
          {dayTasks.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("proj.calendar.none")}</p>
          ) : (
            <ul className="space-y-1">
              {dayTasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={() => onOpenTask(task.id)}
                    className={cn("w-full truncate rounded-md px-2 py-1 text-left text-sm hover:bg-violet-500/10 hover:text-violet-200", task.status === "done" && "text-muted-foreground line-through")}
                  >
                    {task.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
