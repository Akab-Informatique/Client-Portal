import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, Check, ChevronDown, FolderKanban, MoreHorizontal, Pencil, RotateCcw, Send, Trash2, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { longDateTime, shortDate } from "@/pages/tickets/shared";

type Note = { id: string; text: string; authorName: string; createdAt: string };
type Member = { id: string; name: string };
type Project = { id: string; title: string; client: string | null; dueDate: string | null; doneAt: string | null; createdAt: string; members: Member[]; notes: Note[] };
type Projects = { doneCount: number; items: Project[] };
type Draft = { title: string; client: string; dueDate: string; memberIds: string[] };

const today = () => new Date().toLocaleDateString("en-CA");
const daysUntil = (date: string) => Math.round((new Date(`${date}T12:00:00`).getTime() - new Date(`${today()}T12:00:00`).getTime()) / 86_400_000);

/** Weekly meeting: projects in progress, with due dates and notes (refreshed live). */
export function ProjectsSection() {
  const { t } = useTranslation();
  const can = useCan();
  const manage = can("meetings.manage");
  const [showDone, setShowDone] = useState(false);
  const qc = useQueryClient();
  const key = ["meetings", "projects", showDone ? "done" : "open"];
  const { data, isLoading, isError } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Projects>(`/meetings/projects${showDone ? "?done=1" : ""}`),
    // Several people follow the meeting at once: changes show up within seconds
    refetchInterval: 10_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["meetings", "projects"] });

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <FolderKanban className="size-5 text-primary" /> {t(showDone ? "meetings.projects.doneTitle" : "meetings.projects.title")}
          {data && !showDone && <span className="text-sm font-normal text-muted-foreground">({data.items.length})</span>}
        </h2>
        <div className="flex gap-2">
          {data && (data.doneCount > 0 || showDone) && (
            <Button variant="ghost" size="sm" onClick={() => setShowDone((v) => !v)}>
              {showDone ? t("meetings.projects.showOpen") : t("meetings.projects.showDone", { count: data.doneCount })}
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-40 rounded-2xl" />
          ))}
        </div>
      ) : isError || !data ? (
        <p className="py-10 text-center text-muted-foreground">{t("common.error")}</p>
      ) : data.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-10 text-center text-muted-foreground">
          {t(showDone ? "meetings.projects.noneDone" : "meetings.projects.emptyReadOnly")}
        </div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {data.items.map((p) => (
            <ProjectCard key={p.id} project={p} manage={manage} onChanged={refresh} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectForm({ initial, busy, onSave, onCancel }: { initial: Draft; busy: boolean; onSave: (d: Draft) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [d, setD] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (d.title.trim()) onSave(d);
  };
  return (
    <form onSubmit={submit} className="grid gap-2 rounded-2xl border bg-card/80 p-4 sm:grid-cols-[2fr_1.4fr_auto]">
      <Input autoFocus required maxLength={200} placeholder={t("meetings.projects.titlePlaceholder")} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
      <Input maxLength={200} placeholder={t("meetings.projects.clientPlaceholder")} value={d.client} onChange={(e) => setD({ ...d, client: e.target.value })} />
      <Input type="date" aria-label={t("meetings.projects.dueDate")} value={d.dueDate} onChange={(e) => setD({ ...d, dueDate: e.target.value })} className="sm:w-40" />
      <MemberPicker value={d.memberIds} onChange={(memberIds) => setD({ ...d, memberIds })} />
      <div className="flex gap-2 sm:col-start-3 sm:justify-end">
        <Button type="submit" disabled={busy || !d.title.trim()}>
          <Check className="size-4" /> {t("common.save")}
        </Button>
        <Button type="button" variant="ghost" size="icon" onClick={onCancel} aria-label={t("common.cancel")}>
          <X className="size-4" />
        </Button>
      </div>
    </form>
  );
}

/** Choose the team members on the project (active staff). */
function MemberPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useTranslation();
  const team = useQuery({ queryKey: ["meetings", "team"], queryFn: () => api.get<Member[]>("/meetings/team"), staleTime: 5 * 60_000 });
  const names = (team.data ?? []).filter((m) => value.includes(m.id)).map((m) => m.name);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="justify-between font-normal sm:col-span-2">
          <span className="flex min-w-0 items-center gap-2">
            <Users className="size-4 shrink-0 text-muted-foreground" />
            <span className={cn("truncate", !names.length && "text-muted-foreground")}>{names.length ? names.join(", ") : t("meetings.projects.assign")}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        {(team.data ?? []).map((m) => (
          <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50">
            <Checkbox checked={value.includes(m.id)} onCheckedChange={() => toggle(m.id)} />
            {m.name}
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function DueChip({ date }: { date: string }) {
  const { t } = useTranslation();
  const n = daysUntil(date);
  const tone = n < 0 ? "border-red-500/50 bg-red-500/15 text-red-300" : n <= 7 ? "border-orange-500/40 bg-orange-500/10 text-orange-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  const text = n < 0 ? t("meetings.projects.late", { count: -n }) : n === 0 ? t("meetings.projects.dueToday") : t("meetings.projects.dueIn", { count: n });
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs", tone)}>
      <CalendarClock className="size-3.5" /> {shortDate(date)} · {text}
    </span>
  );
}

function ProjectCard({ project: p, manage, onChanged }: { project: Project; manage: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const onError = () => toast.error(t("common.error"));

  const update = useMutation({
    mutationFn: (patch: Partial<Draft> & { done?: boolean }) => api.patch(`/meetings/projects/${p.id}`, patch),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
    onError,
  });
  const remove = useMutation({ mutationFn: () => api.del(`/meetings/projects/${p.id}`), onSuccess: onChanged, onError });
  const addNote = useMutation({
    mutationFn: (text: string) => api.post(`/meetings/projects/${p.id}/notes`, { text }),
    onSuccess: () => {
      setNote("");
      onChanged();
    },
    onError,
  });
  const removeNote = useMutation({ mutationFn: (id: string) => api.del(`/meetings/projects/${p.id}/notes/${id}`), onSuccess: onChanged, onError });

  const sendNote = () => {
    if (note.trim() && !addNote.isPending) addNote.mutate(note.trim());
  };

  if (editing) {
    return (
      <ProjectForm
        initial={{ title: p.title, client: p.client ?? "", dueDate: p.dueDate ?? "", memberIds: p.members.map((m) => m.id) }}
        busy={update.isPending}
        onCancel={() => setEditing(false)}
        onSave={(d) => update.mutate(d)}
      />
    );
  }

  return (
    <div className={cn("overflow-hidden rounded-2xl border bg-card/80", p.doneAt && "opacity-75")}>
      <div className="flex items-start gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{p.title}</p>
          {p.client && <p className="truncate text-sm text-muted-foreground">{p.client}</p>}
          {p.members.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {p.members.map((m) => (
                <span key={m.id} className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 py-0.5 pl-0.5 pr-2 text-xs">
                  <span className="flex size-5 items-center justify-center rounded-full bg-primary/20 text-[10px] font-semibold text-primary">{initials(m.name)}</span>
                  {m.name}
                </span>
              ))}
            </div>
          )}
        </div>
        {p.doneAt ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-emerald-400">
            <Check className="size-3.5" /> {t("meetings.projects.doneOn", { date: shortDate(p.doneAt) })}
          </span>
        ) : p.dueDate ? (
          <DueChip date={p.dueDate} />
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">{t("meetings.projects.noDueDate")}</span>
        )}
        {manage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="-my-1 size-8 shrink-0" aria-label={t("meetings.projects.actions")}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!p.doneAt && (
                <DropdownMenuItem onSelect={() => setEditing(true)}>
                  <Pencil className="size-4" /> {t("common.edit")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => update.mutate({ done: !p.doneAt })}>
                {p.doneAt ? <RotateCcw className="size-4" /> : <Check className="size-4" />} {t(p.doneAt ? "meetings.projects.reopen" : "meetings.projects.markDone")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-400"
                onSelect={() => void confirm({ title: t("meetings.projects.deleteConfirm", { title: p.title }), destructive: true }).then((ok) => ok && remove.mutate())}
              >
                <Trash2 className="size-4" /> {t("common.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="space-y-3 px-4 py-3">
        {manage && !p.doneAt && (
          <div className="flex items-end gap-2">
            <Textarea
              rows={1}
              maxLength={4000}
              className="min-h-9 resize-none"
              placeholder={t("meetings.projects.notePlaceholder")}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendNote();
                }
              }}
            />
            <Button size="icon" className="size-9 shrink-0" disabled={!note.trim() || addNote.isPending} onClick={sendNote} aria-label={t("meetings.projects.addNote")}>
              <Send className="size-4" />
            </Button>
          </div>
        )}
        {p.notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("meetings.projects.noNotes")}</p>
        ) : (
          <ul className="max-h-72 space-y-2 overflow-y-auto">
            {p.notes.map((n) => (
              <li key={n.id} className="group rounded-lg bg-muted/40 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">{n.authorName}</span>
                  <span>{longDateTime(n.createdAt)}</span>
                  {manage && !p.doneAt && (
                    <button
                      type="button"
                      className="ml-auto opacity-0 transition-opacity hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
                      aria-label={t("common.delete")}
                      onClick={() => void confirm({ title: t("meetings.projects.deleteNoteConfirm"), destructive: true }).then((ok) => ok && removeNote.mutate(n.id))}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
                <p className="mt-0.5 whitespace-pre-wrap text-sm">{n.text}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
