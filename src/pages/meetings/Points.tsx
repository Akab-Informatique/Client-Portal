import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, ArchiveRestore, CalendarClock, ChevronDown, MessageSquareText, Plus, StickyNote, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { currentLocale } from "@/i18n";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";

type PointNote = {
  id: string;
  text: string;
  authorName: string;
  createdAt: string;
};
type Point = {
  id: string;
  text: string;
  details: string | null;
  doneAt: string | null;
  archivedAt: string | null;
  snoozeUntil: string | null;
  authorName: string;
  createdAt: string;
  notes: PointNote[];
};

/** Details made only of bullet lines ("- …"): shown as a list */
const bulletsOf = (details: string | null) => {
  const lines = (details ?? "").split("\n").filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => l.startsWith("- ")) ? lines.map((l) => l.slice(2)) : null;
};

/** Today and n days later in Québec, YYYY-MM-DD */
const dayQc = (n = 0) => {
  const d = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date())}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** The next Monday (the next meeting) */
const nextMonday = () => {
  const dow = new Date(`${dayQc()}T12:00:00Z`).getUTCDay();
  return dayQc((8 - dow) % 7 || 7);
};
/** "lun. 27 oct." / "Mon, Oct 27" */
const shortDay = (ymd: string) =>
  new Intl.DateTimeFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${ymd}T12:00:00`));

const POINT_KEYS = [
  ["meetings", "points"],
  ["meetings", "points-later"],
  ["meetings", "points-archive"],
] as const;

/** Changes to a point (shared by the list, the "later" list and the archive). */
function usePointActions() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refresh = () => Promise.all(POINT_KEYS.map((queryKey) => qc.invalidateQueries({ queryKey: [...queryKey] })));
  const onError = (e: unknown) => toast.error(e instanceof ApiError && e.code === "snooze_not_future" ? t("meetings.points.laterFuture") : t("common.error"));
  const patch = useMutation({
    mutationFn: ({ id, ...v }: { id: string; done?: boolean; archived?: boolean; snoozeUntil?: string | null }) => api.patch(`/meetings/points/${id}`, v),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/meetings/points/${id}`),
    onSuccess: refresh,
    onError,
  });
  const addNote = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => api.post(`/meetings/points/${id}/notes`, { text }),
    onSuccess: refresh,
    onError,
  });
  const removeNote = useMutation({
    mutationFn: ({ id, noteId }: { id: string; noteId: string }) => api.del(`/meetings/points/${id}/notes/${noteId}`),
    onSuccess: refresh,
    onError,
  });
  return { patch, remove, addNote, removeNote };
}

/** Weekly meeting: points to discuss with the team, with notes; settled, archived or put off to a later meeting. */
export function PointsSection() {
  const { t } = useTranslation();
  const manage = useCan()("meetings.manage");
  const [text, setText] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  // the points to discuss, or the archive (same card)
  const [view, setView] = useState<"open" | "archive">("open");
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["meetings", "points"],
    queryFn: () => api.get<Point[]>("/meetings/points"),
    refetchInterval: 10_000,
  });
  const { data: later = [] } = useQuery({
    queryKey: ["meetings", "points-later"],
    queryFn: () => api.get<Point[]>("/meetings/points/later"),
    refetchInterval: 60_000,
  });
  const { data: archived = [] } = useQuery({
    queryKey: ["meetings", "points-archive"],
    queryFn: () => api.get<Point[]>("/meetings/points/archive"),
  });
  const actions = usePointActions();
  const add = useMutation({
    mutationFn: (v: string) => api.post("/meetings/points", { text: v }),
    onSuccess: () => {
      setText("");
      void qc.invalidateQueries({ queryKey: ["meetings", "points"] });
    },
    onError: () => toast.error(t("common.error")),
  });

  const open = (data ?? []).filter((p) => !p.doneAt);
  const points = [...open, ...(data ?? []).filter((p) => p.doneAt)];

  return (
    <section className="space-y-3">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <MessageSquareText className="size-5 text-primary" /> {t("meetings.points.title")}
        </h2>
        <div className="flex items-center gap-2">
          {view === "open" && later.length > 0 && <LaterList points={later} manage={manage} />}
          <div className="flex rounded-lg border bg-card/60 p-0.5" role="tablist">
            {(
              [
                {
                  key: "open",
                  icon: MessageSquareText,
                  label: t("meetings.points.viewOpen"),
                  count: open.length,
                },
                {
                  key: "archive",
                  icon: Archive,
                  label: t("meetings.points.viewArchive"),
                  count: archived.length,
                },
              ] as const
            ).map((x) => (
              <button
                key={x.key}
                type="button"
                role="tab"
                aria-selected={view === x.key}
                onClick={() => setView(x.key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors",
                  view === x.key ? "bg-primary/15 font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <x.icon className="size-3.5" /> {x.label}
                <span className="tabular-nums text-xs text-muted-foreground">{x.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="overflow-hidden rounded-2xl border bg-card/80">
        {view === "archive" ? (
          <ArchiveList points={archived} manage={manage} />
        ) : (
          <>
            {manage && (
              <form
                className="flex gap-2 border-b p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (text.trim()) add.mutate(text.trim());
                }}
              >
                <Input maxLength={2000} placeholder={t("meetings.points.placeholder")} value={text} onChange={(e) => setText(e.target.value)} />
                <Button type="submit" disabled={!text.trim() || add.isPending}>
                  <Plus className="size-4" /> {t("meetings.points.add")}
                </Button>
              </form>
            )}
            {isLoading ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
              </div>
            ) : isError ? (
              <p className="p-6 text-center text-muted-foreground">{t("common.error")}</p>
            ) : points.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">{t("meetings.points.empty")}</p>
            ) : (
              <ul className="max-h-[36rem] divide-y overflow-y-auto">
                {points.map((p) => (
                  <PointRow
                    key={p.id}
                    p={p}
                    manage={manage}
                    expanded={openId === p.id}
                    onToggle={() => setOpenId((v) => (v === p.id ? null : p.id))}
                    actions={actions}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function PointRow({
  p,
  manage,
  expanded,
  onToggle,
  actions,
}: {
  p: Point;
  manage: boolean;
  expanded: boolean;
  onToggle: () => void;
  actions: ReturnType<typeof usePointActions>;
}) {
  const { t } = useTranslation();
  return (
    <li className={cn("group", expanded && "bg-muted/30")}>
      <div className="flex items-start gap-3 px-4 py-2.5">
        <Checkbox
          className="mt-0.5"
          checked={Boolean(p.doneAt)}
          disabled={!manage}
          onCheckedChange={() => actions.patch.mutate({ id: p.id, done: !p.doneAt })}
          aria-label={t(p.doneAt ? "meetings.points.reopen" : "meetings.points.markDone")}
        />
        <button type="button" className={cn("min-w-0 flex-1 text-left", p.doneAt && "text-muted-foreground")} onClick={onToggle} aria-expanded={expanded}>
          <p className={cn("whitespace-pre-wrap text-sm", p.doneAt && "line-through")}>{p.text}</p>
          {p.details && <Details details={p.details} />}
          <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
            <span>{p.authorName}</span>
            {p.notes.length > 0 && (
              <span className="inline-flex items-center gap-1 text-primary">
                <StickyNote className="size-3" /> {t("meetings.points.noteCount", { count: p.notes.length })}
              </span>
            )}
          </p>
        </button>
        <div className={cn("flex shrink-0 items-center gap-0.5 transition-opacity", !expanded && "opacity-60 group-hover:opacity-100")}>
          <IconButton label={expanded ? t("common.close") : t("meetings.points.notes")} onClick={onToggle}>
            <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
          </IconButton>
          {manage && (
            <>
              <LaterButton onPick={(day) => actions.patch.mutate({ id: p.id, snoozeUntil: day })} />
              <IconButton label={t("meetings.points.archive")} onClick={() => actions.patch.mutate({ id: p.id, archived: true })}>
                <Archive className="size-4" />
              </IconButton>
              <IconButton label={t("common.delete")} danger onClick={() => actions.remove.mutate(p.id)}>
                <Trash2 className="size-4" />
              </IconButton>
            </>
          )}
        </div>
      </div>
      {expanded && <Notes p={p} manage={manage} actions={actions} />}
    </li>
  );
}

/** The point's notes, oldest first, and a field to add one. */
function Notes({ p, manage, actions }: { p: Point; manage: boolean; actions: ReturnType<typeof usePointActions> }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  return (
    <div className="space-y-2 px-4 pb-3 pl-11">
      {p.notes.length === 0 && <p className="text-xs text-muted-foreground">{t("meetings.points.noNotes")}</p>}
      {p.notes.length > 0 && (
        <ul className="space-y-1.5 border-l-2 border-primary/30 pl-3">
          {p.notes.map((n) => (
            <li key={n.id} className="group/note text-sm">
              <p className="whitespace-pre-wrap">{n.text}</p>
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                {n.authorName} · {relativeTime(n.createdAt)}
                {manage && (
                  <button
                    type="button"
                    className="opacity-0 transition-opacity hover:text-red-400 focus-visible:opacity-100 group-hover/note:opacity-100"
                    aria-label={t("common.delete")}
                    onClick={() => actions.removeNote.mutate({ id: p.id, noteId: n.id })}
                  >
                    <X className="size-3" />
                  </button>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
      {manage && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            actions.addNote.mutate({ id: p.id, text: text.trim() }, { onSuccess: () => setText("") });
          }}
        >
          <Input
            className="h-8 text-sm"
            maxLength={4000}
            placeholder={t("meetings.points.notePlaceholder")}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!text.trim() || actions.addNote.isPending}>
            {t("meetings.points.addNote")}
          </Button>
        </form>
      )}
    </div>
  );
}

function IconButton({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={cn("rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent", danger ? "hover:text-red-400" : "hover:text-foreground")}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Put a point off: next meeting, in two weeks, or a chosen day. */
function LaterButton({ onPick }: { onPick: (day: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(nextMonday());
  const pick = (d: string) => {
    onPick(d);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("meetings.points.later")}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <CalendarClock className="size-4" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("meetings.points.later")}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 space-y-3">
        <p className="text-sm font-medium">{t("meetings.points.laterTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("meetings.points.laterHint")}</p>
        <div className="flex flex-wrap gap-1.5">
          {[
            { label: t("meetings.points.laterNextMeeting"), day: nextMonday() },
            { label: t("meetings.points.laterTwoWeeks"), day: dayQc(14) },
            { label: t("meetings.points.laterMonth"), day: dayQc(30) },
          ].map((o) => (
            <Button key={o.label} type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => pick(o.day)}>
              {o.label}
            </Button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (day > dayQc()) pick(day);
          }}
        >
          <Input type="date" className="h-8" min={dayQc(1)} value={day} onChange={(e) => setDay(e.target.value)} />
          <Button type="submit" size="sm" disabled={!day || day <= dayQc()}>
            {t("meetings.points.laterSave")}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** Points put off: when each comes back, and bring one back now. */
function LaterList({ points, manage }: { points: Point[]; manage: boolean }) {
  const { t } = useTranslation();
  const { patch } = usePointActions();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5">
          <CalendarClock className="size-4 text-primary" /> {t("meetings.points.laterList", { count: points.length })}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <p className="border-b px-3 py-2 text-sm font-medium">{t("meetings.points.laterListTitle")}</p>
        <ul className="max-h-80 divide-y overflow-y-auto">
          {points.map((p) => (
            <li key={p.id} className="flex items-start gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm">{p.text}</p>
                <p className="text-xs text-muted-foreground">
                  {t("meetings.points.backOn", {
                    date: shortDay(p.snoozeUntil!),
                  })}
                </p>
              </div>
              {manage && (
                <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => patch.mutate({ id: p.id, snoozeUntil: null })}>
                  <Undo2 className="size-3.5" /> {t("meetings.points.bringBack")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** The archive view of the points card: archived points with their notes; restore puts one back on the list. */
function ArchiveList({ points, manage }: { points: Point[]; manage: boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const { patch, remove } = usePointActions();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = points.filter((p) => words.every((w) => `${p.text} ${p.details ?? ""} ${p.notes.map((n) => n.text).join(" ")}`.toLowerCase().includes(w)));
  return (
    <>
      <div className="border-b p-3">
        <Input className="h-9" placeholder={t("meetings.points.archiveSearch")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {shown.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">{t("meetings.points.archiveEmpty")}</p>
      ) : (
        <ul className="max-h-[36rem] divide-y overflow-y-auto">
          {shown.map((p) => (
            <li key={p.id} className="group flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{p.text}</p>
                {p.details && <Details details={p.details} />}
                {p.notes.length > 0 && (
                  <ul className="mt-1.5 space-y-1 border-l-2 border-primary/30 pl-3">
                    {p.notes.map((n) => (
                      <li key={n.id} className="text-sm">
                        <span className="whitespace-pre-wrap">{n.text}</span>{" "}
                        <span className="text-xs text-muted-foreground">
                          — {n.authorName}, {relativeTime(n.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {p.authorName} ·{" "}
                  {t("meetings.points.archivedOn", {
                    when: relativeTime(p.archivedAt!),
                  })}
                </p>
              </div>
              {manage && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <IconButton label={t("meetings.points.restore")} onClick={() => patch.mutate({ id: p.id, archived: false })}>
                    <ArchiveRestore className="size-4" />
                  </IconButton>
                  <IconButton label={t("common.delete")} danger onClick={() => remove.mutate(p.id)}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Details of points added before the fast field only (a description or bullets) */
function Details({ details }: { details: string }) {
  const bullets = bulletsOf(details);
  if (bullets) {
    return (
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
        {bullets.map((b, i) => (
          <li key={i} className="whitespace-pre-wrap">
            {b}
          </li>
        ))}
      </ul>
    );
  }
  return <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{details}</p>;
}
