import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ConfirmDialog";
import { AiModelButton, useAiModel } from "@/components/AiModelPicker";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAiError } from "./TicketPanel";
import { ticketErrorText } from "./shared";

type Action = { type: string; id?: number; label: string; request: { method: "PATCH" | "PUT" | "POST" | "DELETE"; path: string; body?: unknown } | null };
type Answer = { reply: string; actions: Action[]; refused: string[] };
/** One turn of the conversation: what the person said, or what the assistant answered with the actions it proposes */
type Turn = { role: "user"; text: string } | { role: "assistant"; text: string; actions: Action[]; refused: string[]; picked: Set<number>; results: Record<number, "ok" | string>; applied: boolean };

/**
 * The AI assistant of the tickets page, as a conversation. You write what you want; the AI answers, and when it needs more
 * ("which ticket?", "what date?") it asks and you answer — it keeps the whole discussion in mind. When the request is clear it
 * proposes actions: it only knows the tickets you can see and only proposes what your rights allow; nothing is done until you
 * tick and apply, and each action goes through the usual routes, which check your rights again.
 */
export function AssistantDialog({ onClose, onPlan }: { onClose: () => void; onPlan: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const aiError = useAiError();
  // the AI model for this talk (Sonnet, Opus, Haiku…): the part's own unless one is picked here
  const model = useAiModel("tickets.assistant");
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // (braces: an effect must return nothing)
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns.length]);

  /** What the assistant is told of the earlier turns (its own proposals, and whether they were applied) */
  const history = (list: Turn[]) =>
    list.slice(-14).map((x) =>
      x.role === "user"
        ? { role: "user" as const, text: x.text }
        : { role: "assistant" as const, text: [x.text, ...(x.actions.length ? [`Actions proposées (${x.applied ? "appliquées" : "pas encore appliquées"}) : ${x.actions.map((a) => a.label).join(" ; ")}`] : [])].join("\n") },
    );
  const ask = useMutation({
    mutationFn: ({ message, before }: { message: string; before: Turn[] }) => api.post<Answer>("/tickets/ai/assistant", { message, history: history(before), ...model.body }),
    onSuccess: (r) =>
      setTurns((list) => [
        ...list,
        // proposed actions start ticked, except a deletion (it has to be chosen on purpose)
        { role: "assistant", text: r.reply, actions: r.actions, refused: r.refused, picked: new Set(r.actions.map((a, i) => (a.type === "delete_ticket" ? -1 : i)).filter((i) => i >= 0)), results: {}, applied: false },
      ]),
    onError: (e) => toast.error(aiError(e), { description: e instanceof ApiError ? e.code : undefined }),
  });
  const send = (message: string) => {
    const m = message.trim();
    if (!m || ask.isPending) return;
    const before = turns;
    setTurns([...before, { role: "user", text: m }]);
    setText("");
    ask.mutate({ message: m, before });
  };

  const apply = useMutation({
    mutationFn: async (index: number) => {
      const turn = turns[index];
      if (turn?.role !== "assistant") return { index, out: {} as Record<number, "ok" | string>, plan: false };
      const out: Record<number, "ok" | string> = {};
      let plan = false;
      for (const [i, a] of turn.actions.entries()) {
        if (!turn.picked.has(i)) continue;
        if (a.type === "plan_my_tickets") {
          plan = true;
          out[i] = "ok";
          continue;
        }
        if (!a.request) continue;
        try {
          if (a.request.method === "PATCH") await api.patch(a.request.path, a.request.body);
          else if (a.request.method === "PUT") await api.put(a.request.path, a.request.body);
          else if (a.request.method === "POST") await api.post(a.request.path, a.request.body);
          else await api.del(a.request.path);
          out[i] = "ok";
        } catch (e) {
          out[i] = ticketErrorText(t, e);
        }
      }
      return { index, out, plan };
    },
    onSuccess: ({ index, out, plan }) => {
      setTurns((list) => list.map((x, i) => (i === index && x.role === "assistant" ? { ...x, results: out, applied: true } : x)));
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      const failed = Object.values(out).filter((v) => v !== "ok").length;
      if (failed) toast.warning(t("tickets.assistant.someFailed", { count: failed }));
      else toast.success(t("tickets.assistant.done", { count: Object.keys(out).length }));
      if (plan) {
        onClose();
        onPlan();
      }
    },
  });
  const run = async (index: number) => {
    const turn = turns[index];
    if (turn?.role !== "assistant") return;
    const del = turn.actions.filter((a, i) => turn.picked.has(i) && a.type === "delete_ticket");
    if (del.length && !(await confirm({ title: t("tickets.assistant.deleteTitle", { count: del.length }), description: del.map((d) => d.label).join("\n"), confirmLabel: t("tickets.delete.confirm"), destructive: true }))) return;
    apply.mutate(index);
  };
  const toggle = (index: number, i: number, on: boolean) =>
    setTurns((list) =>
      list.map((x, k) => {
        if (k !== index || x.role !== "assistant") return x;
        const picked = new Set(x.picked);
        if (on) picked.add(i);
        else picked.delete(i);
        return { ...x, picked };
      }),
    );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-violet-300" /> {t("tickets.assistant.title")}
            <span className="ml-auto pr-6">
              <AiModelButton feature="tickets.assistant" m={model} />
            </span>
          </DialogTitle>
          <DialogDescription>{t("tickets.assistant.hint")}</DialogDescription>
        </DialogHeader>

        <div className="min-h-32 flex-1 space-y-3 overflow-y-auto pr-1">
          {turns.length === 0 && (
            <div className="flex flex-wrap gap-1.5">
              {["plan", "overdue", "week"].map((k) => (
                <button key={k} type="button" onClick={() => setText(t(`tickets.assistant.example.${k}`))} className="rounded-full border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:border-[color:var(--gold)]/50 hover:text-foreground">
                  {t(`tickets.assistant.example.${k}`)}
                </button>
              ))}
            </div>
          )}
          {turns.map((turn, index) =>
            turn.role === "user" ? (
              <div key={index} className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-[color:var(--gold)]/15 px-3 py-2 text-sm">{turn.text}</p>
              </div>
            ) : (
              <div key={index} className="space-y-2">
                {turn.text && <p className="max-w-[92%] whitespace-pre-wrap rounded-2xl bg-violet-500/10 px-3 py-2 text-sm leading-relaxed">{turn.text}</p>}
                {turn.refused.length > 0 && <p className="rounded-lg border border-orange-400/30 bg-orange-400/10 px-3 py-2 text-xs text-orange-200">{t("tickets.assistant.refused", { list: turn.refused.join(", ") })}</p>}
                {turn.actions.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("tickets.assistant.proposed")}</p>
                    <ul className="max-h-72 divide-y overflow-y-auto rounded-xl border">
                      {turn.actions.map((a, i) => (
                        <li key={i} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                          <Checkbox checked={turn.picked.has(i)} disabled={apply.isPending || turn.applied} onCheckedChange={(v) => toggle(index, i, v === true)} />
                          <span className={cn("min-w-0 flex-1", a.type === "delete_ticket" && "text-destructive")}>{a.label}</span>
                          {turn.results[i] === "ok" && <Check className="size-4 text-emerald-400" />}
                          {turn.results[i] && turn.results[i] !== "ok" && (
                            <span className="flex items-center gap-1 text-xs text-destructive">
                              <X className="size-3.5" /> {turn.results[i]}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                    {!turn.applied && (
                      <div className="flex justify-end">
                        <Button size="sm" disabled={!turn.picked.size || apply.isPending} onClick={() => void run(index)} className="gap-2 bg-grad-gold font-semibold text-[#1a1204]">
                          {apply.isPending && <Loader2 className="size-4 animate-spin" />} {t("tickets.assistant.apply", { count: turn.picked.size })}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ),
          )}
          {ask.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {t("tickets.assistant.thinking")}
            </p>
          )}
          <div ref={bottom} />
        </div>

        <form
          className="space-y-1.5 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <div className="flex items-end gap-2">
            <Textarea
              autoFocus
              rows={2}
              maxLength={2000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={turns.length ? t("tickets.assistant.reply") : t("tickets.assistant.placeholder")}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter makes a new line
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(text);
                }
              }}
            />
            <Button type="submit" size="icon" disabled={!text.trim() || ask.isPending} className="size-10 shrink-0 bg-grad-gold text-[#1a1204]" aria-label={t("tickets.assistant.send")}>
              {ask.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">{t("tickets.assistant.safety")}</p>
            {turns.length > 0 && (
              <button type="button" onClick={() => setTurns([])} className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground">
                {t("tickets.assistant.newTalk")}
              </button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
