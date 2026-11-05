import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { BellRing, Loader2, Mail, MessageSquareText, Send, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { Person } from "./shared";
import { taskError } from "./TaskDialog";

type Channel = "email" | "sms" | "teams";
type Outcome = "sent" | "failed" | "no_address" | "not_ready";
type Result = { people: { id: string; name: string; email?: Outcome; sms?: Outcome; teams?: Outcome }[] };
const CHANNELS: { key: Channel; icon: typeof Mail }[] = [
  { key: "email", icon: Mail },
  { key: "sms", icon: MessageSquareText },
  { key: "teams", icon: Users },
];

/** Tell colleagues about a task: the bell always, then an email, a text and a Teams message as ticked (same wording as for a ticket). */
export function TaskNotify({ task, people, onClose }: { task: { id: string; title: string }; people: Person[]; onClose: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const defaults = me.preferences.notify ?? { email: true, sms: false, teams: false };
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [ch, setCh] = useState<Record<Channel, boolean>>({ email: defaults.email, sms: defaults.sms, teams: defaults.teams });
  const others = people.filter((p) => p.id !== me.id);
  const send = useMutation({
    mutationFn: () => api.post<Result>(`/pipeline/tasks/${task.id}/notify`, { userIds: picked, message: message.trim(), channels: ch }),
    onSuccess: (r) => {
      toast.success(t("tickets.notifyTech.sent", { count: r.people.length }));
      for (const p of r.people)
        for (const k of ["email", "sms", "teams"] as const) {
          const o = p[k];
          if (o && o !== "sent") toast.warning(t("tickets.notifyTech.problem", { name: p.name, channel: t(`tickets.notifyTech.channel.${k}`), why: t(`tickets.notifyTech.why.${o}`) }));
        }
      onClose();
    },
    onError: (e) => toast.error(taskError(t, e)),
  });
  const toggle = (id: string) => setPicked((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BellRing className="size-5 text-primary" /> {t("tickets.notifyTech.title")}
          </DialogTitle>
          <DialogDescription>{task.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ul className="max-h-48 divide-y divide-border/60 overflow-y-auto rounded-xl border">
            {others.map((p) => (
              <li key={p.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent/40">
                  <Checkbox checked={picked.includes(p.id)} onCheckedChange={() => toggle(p.id)} />
                  {p.name}
                </label>
              </li>
            ))}
          </ul>
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxLength={1000} placeholder={t("tickets.notifyTech.messageHint")} />
          <div className="flex flex-wrap gap-2">
            <span className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300">
              <BellRing className="size-3.5" /> {t("tickets.notifyTech.channel.bell")}
            </span>
            {CHANNELS.map(({ key, icon: Icon }) => (
              <label key={key} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors", ch[key] ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 text-foreground" : "text-muted-foreground hover:bg-accent/40")}>
                <Checkbox checked={ch[key]} onCheckedChange={(v) => setCh((c) => ({ ...c, [key]: v === true }))} />
                <Icon className="size-3.5" /> {t(`tickets.notifyTech.channel.${key}`)}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!picked.length || send.isPending} onClick={() => send.mutate()} className="bg-grad-gold font-semibold text-[#1a1204]">
            {send.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("tickets.notifyTech.send")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
