import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Clock, Paperclip, Pause, Play, Square, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AiTextarea } from "@/components/AiPolish";
import { useConfirm } from "@/components/ConfirmDialog";
import { RecipientInput } from "@/pages/outlook/RecipientInput";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { useDraft } from "@/lib/useDraft";
import { cn } from "@/lib/utils";
import { hm, parseHm } from "@shared/duration";
import type { ProjDetail, ProjFile, ProjNote, ProjTimer } from "./shared";

type TFn = (k: string, o?: Record<string, unknown>) => string;
type ClientContact = { id: string; firstName: string; lastName: string; email: string | null };

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
export const isEmail = (s: string) => EMAIL.test(s.trim());
export const todayYmd = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

const KNOWN = ["project_closed", "timesheet_locked", "task_blocked", "task_cycle", "task_invalid", "person_invalid", "project_no_client", "reply_needs_recipient", "not_found", "entry_billed", "time_billed", "quote_forbidden", "hours_invalid"];

/** A server refusal as a sentence (known codes translated, others shown with their code). */
export function projError(t: TFn, e: unknown): string {
  if (e instanceof ApiError && KNOWN.includes(e.code)) return t(`projWork.errors.${e.code}`);
  if (e instanceof ApiError && e.code && e.code !== "error" && !e.code.startsWith("http_")) return t("projWork.errorCode", { code: e.code });
  return t("projWork.error");
}

/** Seconds on a timer → hours, rounded UP to the quarter hour, at least a quarter. */
export function quarterHours(seconds: number): number {
  return Math.max(0.25, Math.ceil(Math.max(0, seconds) / 900) / 4);
}

/** Seconds as h:mm:ss */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The seconds a timer shows right now. The server gives `seconds` when it answered; the page counts from there
 * (a paused timer stands still). Re-anchored whenever the server's timer changes.
 */
export function useTimerSeconds(timer: ProjTimer | null | undefined): number {
  const anchor = useMemo(() => ({ at: Date.now(), seconds: timer?.seconds ?? 0 }), [timer?.startedAt, timer?.baseSeconds, timer?.paused, timer?.seconds]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = Boolean(timer) && !timer?.paused;
  const [now, setNow] = useState(() => Date.now());
  useTick(running, setNow);
  if (!timer) return 0;
  return timer.paused ? timer.seconds : anchor.seconds + Math.max(0, (now - anchor.at) / 1000);
}

function useTick(running: boolean, setNow: (n: number) => void) {
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, setNow]);
}

type Tab = "reply" | "note" | "time";

/**
 * The project's writing box: a public reply (emailed to the client), an internal note, a time entry,
 * and the project timer beside the tabs. Read only without `proj.edit` or when the project is done/cancelled.
 */
export function ProjComposer({ project }: { project: ProjDetail }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const closed = project.status === "done" || project.status === "cancelled";
  const canEdit = can("proj.edit") && !closed;
  const canTime = canEdit && can("timesheets.use");
  const clientId = project.client?.id ?? null;

  const [tab, setTab] = useState<Tab>("reply");

  // ── public reply / internal note ──
  const [text, setText, clearText] = useDraft(`proj:${project.id}:note`);
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [to, setTo] = useState<string[]>([]);
  const [mailChoice, setMailChoice] = useState<boolean | null>(null);
  // files uploaded first, sent with the note or the reply (kept like a ticket's)
  const [files, setFiles] = useState<ProjFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        if (file.size > 5 * 1024 * 1024) {
          toast.error(t("projBill.attach.tooBig"));
          continue;
        }
        const data = await new Promise<string>((ok, bad) => {
          const r = new FileReader();
          r.onload = () => ok(String(r.result).split(",")[1] ?? "");
          r.onerror = () => bad(r.error);
          r.readAsDataURL(file);
        });
        try {
          const row = await api.post<ProjFile>(`/proj/${project.id}/files`, { name: file.name, contentType: file.type || undefined, data });
          setFiles((x) => [...x, row]);
        } catch {
          toast.error(t("projBill.attach.failed"));
        }
      }
    } finally {
      setUploading(false);
    }
  };
  const dropFile = (id: string) => {
    setFiles((x) => x.filter((f) => f.id !== id));
    void api.del(`/proj/${project.id}/files/${id}`).catch(() => undefined);
  };

  const contacts = useQuery({
    queryKey: ["proj", "contacts", clientId],
    queryFn: () => api.get<ClientContact[]>(`/crm/clients/${clientId}/contacts`),
    enabled: Boolean(clientId) && canEdit && tab === "reply",
    retry: false,
    staleTime: 60_000,
  });
  const mailable = (contacts.data ?? []).filter((c) => c.email && isEmail(c.email)) as (ClientContact & { email: string })[];
  const defaultMail = Boolean(clientId) && mailable.length > 0;
  const mailOn = Boolean(clientId) && (mailChoice ?? defaultMail);

  const send = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<ProjNote & { emailed?: string[]; failed?: string[] }>(`/proj/${project.id}/notes`, body),
    onSuccess: (res, vars) => {
      const emailed = res.emailed ?? [];
      const failed = res.failed ?? [];
      if (vars.internal === false) {
        if (failed.length) toast.error(t("projWork.composer.replyFailed", { to: failed.join(", ") }));
        if (emailed.length) toast.success(t("projWork.composer.replyEmailed", { to: emailed.join(", ") }));
        if (!vars.email || (!emailed.length && !failed.length)) toast.success(t("projWork.composer.replySaved"));
      } else {
        toast.success(t("projWork.composer.noteSaved"));
      }
      clearText();
      setFiles([]);
      setTaskIds([]);
      setTo([]);
      void qc.invalidateQueries({ queryKey: ["proj"] });
    },
    onError: (e) => toast.error(projError(t, e)),
  });

  const submitText = () => {
    const body = text.trim();
    if (!body) return;
    const attachmentIds = files.map((f) => f.id);
    if (tab === "note") return send.mutate({ text: body, internal: true, taskIds, attachmentIds });
    if (mailOn && to.length === 0) return toast.error(t("projWork.composer.noRecipient"));
    send.mutate({ text: body, internal: false, taskIds, email: mailOn, to: mailOn ? to : [], attachmentIds });
  };

  // ── time entry ──
  const [date, setDate] = useState(todayYmd());
  const [hours, setHours] = useState("");
  const [timeNote, setTimeNote, clearTimeNote] = useDraft(`proj:${project.id}:time`);
  // a project sold as a package (fixed price, bank of hours) starts its entries included; each entry can be switched
  const [billable, setBillable] = useState(project.billing.mode !== "fixed" && project.billing.mode !== "bank");
  const [covered, setCovered] = useState<string[]>([]);
  const [finished, setFinished] = useState<string[]>([]);
  const [stopping, setStopping] = useState(false);
  const parsed = parseHm(hours);
  const hoursOk = parsed !== null && parsed > 0 && parsed <= 24;
  const openTasks = project.tasks.filter((k) => k.status !== "done");

  const saveTime = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/proj/${project.id}/${stopping ? "timer/stop" : "time"}`, body),
    onSuccess: () => {
      toast.success(t("projWork.composer.timeSaved"));
      clearTimeNote();
      setHours("");
      setCovered([]);
      setFinished([]);
      setStopping(false);
      void qc.invalidateQueries({ queryKey: ["proj"] });
    },
    onError: (e) => toast.error(projError(t, e)),
  });

  const submitTime = () => {
    if (!hoursOk || parsed === null) return toast.error(t("projWork.composer.hoursInvalid"));
    saveTime.mutate({ date, hours: parsed, note: timeNote.trim(), billable, taskIds: covered, doneTaskIds: finished });
  };

  const toggle = (list: string[], id: string, set: (v: string[]) => void) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  // ── timer ──
  const seconds = useTimerSeconds(project.timer);
  const timer = project.timer;
  const timerCall = useMutation({
    mutationFn: (what: "start" | "pause" | "resume" | "discard") => api.post(`/proj/${project.id}/timer/${what}`, {}),
    onSuccess: (_r, what) => {
      if (what === "start") toast.success(t("projWork.timer.started"));
      if (what === "discard") toast.success(t("projWork.timer.discarded"));
      void qc.invalidateQueries({ queryKey: ["proj"] });
    },
    onError: (e) => toast.error(projError(t, e)),
  });

  const stopTimer = () => {
    setStopping(true);
    setHours(hm(quarterHours(seconds)));
    setTab("time");
  };
  const discard = async () => {
    const ok = await confirm({ title: t("projWork.timer.discardTitle"), description: t("projWork.timer.discardText"), confirmLabel: t("projWork.timer.discard"), destructive: true });
    if (ok) timerCall.mutate("discard");
  };

  if (!canEdit) {
    return (
      <section className="glass rounded-2xl border border-violet-500/30 p-4 text-sm text-muted-foreground">
        {closed ? t("projWork.closedHint") : t("projWork.readOnly")}
      </section>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "reply", label: t("projWork.composer.tabReply") },
    { key: "note", label: t("projWork.composer.tabNote") },
    { key: "time", label: t("projWork.composer.tabTime") },
  ];

  return (
    <section className="glass space-y-3 rounded-2xl border border-violet-500/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label={t("projWork.composer.tabReply")} className="flex flex-wrap gap-1 rounded-xl border bg-background/60 p-1">
          {tabs.map((x) => (
            <button
              key={x.key}
              type="button"
              role="tab"
              aria-selected={tab === x.key}
              onClick={() => setTab(x.key)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                tab === x.key
                  ? x.key === "reply"
                    ? "bg-[color:var(--gold)]/15 text-[color:var(--gold)]"
                    : "bg-violet-500/15 text-violet-200"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {x.label}
            </button>
          ))}
        </div>

        {canTime && (
          <div className="flex flex-wrap items-center gap-2">
            {!timer ? (
              <Button type="button" size="sm" variant="outline" onClick={() => timerCall.mutate("start")} disabled={timerCall.isPending} className="border-violet-500/40 text-violet-200">
                <Play className="size-4" /> {t("projWork.timer.start")}
              </Button>
            ) : (
              <div className={cn("flex flex-wrap items-center gap-2 rounded-xl border px-3 py-1.5", timer.paused ? "border-amber-400/40 bg-amber-500/5" : "border-violet-500/40 bg-violet-500/10")} role="group" aria-label={t("projWork.timer.title")}>
                <Clock className={cn("size-4", timer.paused ? "text-amber-300" : "text-violet-300")} aria-hidden />
                <span className={cn("font-mono text-base font-semibold tabular-nums", timer.paused ? "text-amber-300" : "text-violet-200")} aria-live="off">
                  {clockText(seconds)}
                </span>
                <span className="text-xs text-muted-foreground">{timer.paused ? t("projWork.timer.paused") : t("projWork.timer.running")}</span>
                {timer.paused ? (
                  <Button type="button" size="sm" variant="ghost" onClick={() => timerCall.mutate("resume")} aria-label={t("projWork.timer.resume")} title={t("projWork.timer.resume")}>
                    <Play className="size-4" />
                  </Button>
                ) : (
                  <Button type="button" size="sm" variant="ghost" onClick={() => timerCall.mutate("pause")} aria-label={t("projWork.timer.pause")} title={t("projWork.timer.pause")}>
                    <Pause className="size-4" />
                  </Button>
                )}
                <Button type="button" size="sm" variant="outline" onClick={stopTimer} disabled={stopping} className="border-violet-500/40">
                  <Square className="size-3.5" /> {t("projWork.timer.stop")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => void discard()} className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="size-3.5" /> {t("projWork.timer.discard")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {tab !== "time" ? (
        <div className="space-y-3">
          <AiTextarea
            rows={4}
            maxLength={8000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={tab === "reply" ? t("projWork.composer.replyPlaceholder") : t("projWork.composer.notePlaceholder")}
            aria-label={tab === "reply" ? t("projWork.composer.tabReply") : t("projWork.composer.tabNote")}
          />

          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground">
              <Paperclip className="size-3.5" aria-hidden /> {uploading ? "…" : t("projBill.attach.add")}
              <input type="file" multiple className="sr-only" onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
            </label>
            {files.map((f) => (
              <span key={f.id} className="inline-flex items-center gap-1 rounded-full border bg-background/60 py-0.5 pl-2.5 pr-1 text-xs">
                {f.name}
                <button type="button" aria-label={t("projBill.attach.remove")} title={t("projBill.attach.remove")} onClick={() => dropFile(f.id)} className="grid size-4 place-items-center rounded-full hover:bg-white/10">
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ))}
          </div>

          <TaskTags tasks={project.tasks} selected={taskIds} onToggle={(id) => toggle(taskIds, id, setTaskIds)} label={t("projWork.composer.tagTasks")} empty={t("projWork.composer.noTasks")} />

          {tab === "reply" && (
            <div className="space-y-2 rounded-xl border bg-background/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={`proj-mail-${project.id}`} className="text-sm font-medium">
                  {t("projWork.composer.sendMail")}
                </label>
                <Switch id={`proj-mail-${project.id}`} checked={mailOn} disabled={!clientId} onCheckedChange={(v) => setMailChoice(v)} />
              </div>
              {!clientId ? (
                <p className="text-xs text-muted-foreground">{t("projWork.composer.noClientMail")}</p>
              ) : !mailable.length && contacts.isSuccess ? (
                <p className="text-xs text-muted-foreground">{t("projWork.composer.noContactMail")}</p>
              ) : null}
              {mailOn && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">{t("projWork.composer.clientContacts")}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {mailable.map((c) => {
                      const on = to.includes(c.email);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggle(to, c.email, setTo)}
                          className={cn("rounded-full border px-2.5 py-1 text-xs transition-colors", on ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
                        >
                          {`${c.firstName} ${c.lastName}`.trim()} <span className="opacity-70">{c.email}</span>
                        </button>
                      );
                    })}
                  </div>
                  <RecipientInput label={t("projWork.composer.otherAddresses")} value={to} onChange={setTo} />
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end">
            <Button type="button" onClick={submitText} disabled={!text.trim() || send.isPending} className={tab === "reply" ? "bg-[color:var(--gold)] text-black hover:bg-[color:var(--gold)]/90" : "bg-violet-600 hover:bg-violet-500"}>
              {tab === "reply" ? t("projWork.composer.sendReply") : t("projWork.composer.saveNote")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {stopping && <div className="rounded-lg border border-violet-500/40 bg-violet-500/5 px-3 py-2 text-sm">{t("projWork.composer.stopping")}</div>}
          {!canTime ? (
            <p className="text-sm text-muted-foreground">{t("projWork.timer.noRight")}</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-[10rem_10rem_1fr] sm:items-end">
                <label className="space-y-1 text-sm">
                  <span className="text-xs font-medium text-muted-foreground">{t("projWork.composer.date")}</span>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 w-full rounded-md border bg-background/60 px-2 text-sm" />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-xs font-medium text-muted-foreground">{t("projWork.composer.hours")}</span>
                  <input
                    value={hours}
                    onChange={(e) => setHours(e.target.value)}
                    placeholder={t("projWork.composer.hoursHint")}
                    inputMode="numeric"
                    aria-invalid={hours.trim() !== "" && !hoursOk}
                    className={cn("h-9 w-full rounded-md border bg-background/60 px-2 font-mono text-sm", hours.trim() !== "" && !hoursOk && "border-destructive")}
                  />
                </label>
                <div className="flex items-center gap-2">
                  <Switch id={`proj-bill-${project.id}`} checked={billable} onCheckedChange={setBillable} />
                  <label htmlFor={`proj-bill-${project.id}`} className="text-sm">
                    {t("projWork.composer.billable")}
                  </label>
                </div>
              </div>

              <AiTextarea rows={4} maxLength={2000} value={timeNote} onChange={(e) => setTimeNote(e.target.value)} placeholder={t("projWork.composer.note")} aria-label={t("projWork.composer.note")} />

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">{t("projWork.composer.openTasks")}</p>
                {openTasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("projWork.composer.noTasks")}</p>
                ) : (
                  <ul className="divide-y rounded-xl border">
                    {openTasks.map((k) => {
                      const isCovered = covered.includes(k.id);
                      return (
                        <li key={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
                          <span className="min-w-0 flex-1 truncate">{k.title}</span>
                          <label className="inline-flex items-center gap-1.5 text-xs">
                            <input
                              type="checkbox"
                              className="size-4 accent-violet-500"
                              checked={isCovered}
                              onChange={() => {
                                if (isCovered) {
                                  setCovered(covered.filter((x) => x !== k.id));
                                  setFinished(finished.filter((x) => x !== k.id));
                                } else setCovered([...covered, k.id]);
                              }}
                            />
                            {t("projWork.composer.covered")}
                          </label>
                          <label className={cn("inline-flex items-center gap-1.5 text-xs", !isCovered && "opacity-50")}>
                            <input
                              type="checkbox"
                              className="size-4 accent-emerald-500"
                              disabled={!isCovered}
                              checked={finished.includes(k.id)}
                              onChange={() => toggle(finished, k.id, setFinished)}
                            />
                            {t("projWork.composer.finished")}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                {stopping && (
                  <Button type="button" variant="ghost" onClick={() => setStopping(false)}>
                    {t("projWork.cancel")}
                  </Button>
                )}
                <Button type="button" onClick={submitTime} disabled={!hoursOk || saveTime.isPending} className="bg-violet-600 hover:bg-violet-500">
                  {t("projWork.composer.saveTime")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** The project's tasks as toggles (chips): the tags of a note, or the tasks a time entry covers. */
export function TaskTags({ tasks, selected, onToggle, label, empty }: { tasks: { id: string; title: string }[]; selected: string[]; onToggle: (id: string) => void; label: string; empty: string }) {
  if (!tasks.length) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {tasks.map((k) => {
          const on = selected.includes(k.id);
          return (
            <button
              key={k.id}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(k.id)}
              className={cn("rounded-full border px-2.5 py-1 text-xs transition-colors", on ? "border-violet-400/60 bg-violet-500/20 text-violet-100" : "border-border text-muted-foreground hover:text-foreground")}
            >
              {k.title}
            </button>
          );
        })}
      </div>
    </div>
  );
}
