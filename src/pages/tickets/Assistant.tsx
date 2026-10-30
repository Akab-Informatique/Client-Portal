import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAiError } from "./TicketPanel";
import { ticketErrorText } from "./shared";

type Action = { type: string; id?: number; label: string; request: { method: "PATCH" | "PUT" | "POST" | "DELETE"; path: string; body?: unknown } | null };
type Answer = { reply: string; actions: Action[]; refused: string[] };

/**
 * The AI assistant of the tickets page. You write what you want ("move the due date of T… to Friday", "assign my new tickets to
 * Marc", "plan my week"); the AI answers and proposes actions. It only knows the tickets you can see and only proposes what your
 * rights allow; nothing is done until you tick and apply, and each action goes through the usual routes, which check your rights again.
 */
export function AssistantDialog({ onClose, onPlan }: { onClose: () => void; onPlan: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const aiError = useAiError();
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<Record<number, "ok" | string>>({});
  const ask = useMutation({
    mutationFn: () => api.post<Answer>("/tickets/ai/assistant", { message: text }),
    onSuccess: (r) => {
      setAnswer(r);
      setResults({});
      // proposed actions start ticked, except a deletion (it has to be chosen on purpose)
      setPicked(new Set(r.actions.map((a, i) => (a.type === "delete_ticket" ? -1 : i)).filter((i) => i >= 0)));
    },
    onError: (e) => toast.error(aiError(e)),
  });
  const apply = useMutation({
    mutationFn: async () => {
      const out: Record<number, "ok" | string> = {};
      let plan = false;
      for (const [i, a] of (answer?.actions ?? []).entries()) {
        if (!picked.has(i)) continue;
        if (a.type === "plan_my_tickets") {
          plan = true;
          out[i] = "ok";
          continue;
        }
        if (!a.request) continue;
        try {
          const path = a.request.path;
          if (a.request.method === "PATCH") await api.patch(path, a.request.body);
          else if (a.request.method === "PUT") await api.put(path, a.request.body);
          else if (a.request.method === "POST") await api.post(path, a.request.body);
          else await api.del(path);
          out[i] = "ok";
        } catch (e) {
          out[i] = ticketErrorText(t, e);
        }
      }
      return { out, plan };
    },
    onSuccess: ({ out, plan }) => {
      setResults(out);
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
  const run = async () => {
    const del = (answer?.actions ?? []).filter((a, i) => picked.has(i) && a.type === "delete_ticket");
    if (del.length && !(await confirm({ title: t("tickets.assistant.deleteTitle", { count: del.length }), description: del.map((d) => d.label).join("\n"), confirmLabel: t("tickets.delete.confirm"), destructive: true }))) return;
    apply.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-violet-300" /> {t("tickets.assistant.title")}
          </DialogTitle>
          <DialogDescription>{t("tickets.assistant.hint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim().length >= 2) ask.mutate();
          }}
        >
          <Textarea
            autoFocus
            rows={3}
            maxLength={2000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("tickets.assistant.placeholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (text.trim().length >= 2) ask.mutate();
              }
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {["plan", "overdue", "week"].map((k) => (
                <button key={k} type="button" onClick={() => setText(t(`tickets.assistant.example.${k}`))} className="rounded-full border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:border-[color:var(--gold)]/50 hover:text-foreground">
                  {t(`tickets.assistant.example.${k}`)}
                </button>
              ))}
            </div>
            <Button type="submit" disabled={text.trim().length < 2 || ask.isPending} className="gap-2 bg-grad-gold font-semibold text-[#1a1204]">
              {ask.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("tickets.assistant.send")}
            </Button>
          </div>
        </form>

        {answer && (
          <div className="space-y-3 border-t pt-3">
            {answer.reply && <p className="whitespace-pre-wrap text-sm leading-relaxed">{answer.reply}</p>}
            {answer.refused.length > 0 && <p className="rounded-lg border border-orange-400/30 bg-orange-400/10 px-3 py-2 text-xs text-orange-200">{t("tickets.assistant.refused", { list: answer.refused.join(", ") })}</p>}
            {answer.actions.length > 0 && (
              <>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("tickets.assistant.proposed")}</p>
                <ul className="divide-y rounded-xl border">
                  {answer.actions.map((a, i) => (
                    <li key={i} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                      <Checkbox checked={picked.has(i)} disabled={apply.isPending || results[i] === "ok"} onCheckedChange={(v) => setPicked((s) => { const n = new Set(s); if (v === true) n.add(i); else n.delete(i); return n; })} />
                      <span className={cn("min-w-0 flex-1", a.type === "delete_ticket" && "text-destructive")}>{a.label}</span>
                      {results[i] === "ok" && <Check className="size-4 text-emerald-400" />}
                      {results[i] && results[i] !== "ok" && (
                        <span className="flex items-center gap-1 text-xs text-destructive">
                          <X className="size-3.5" /> {results[i]}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="flex justify-end">
                  <Button disabled={!picked.size || apply.isPending} onClick={() => void run()} className="gap-2 bg-grad-gold font-semibold text-[#1a1204]">
                    {apply.isPending && <Loader2 className="size-4 animate-spin" />} {t("tickets.assistant.apply", { count: picked.size })}
                  </Button>
                </div>
              </>
            )}
            <p className="text-[11px] text-muted-foreground">{t("tickets.assistant.safety")}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
