import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { AiTextarea } from "@/components/AiPolish";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { useDraft } from "@/lib/useDraft";
import { Card } from "./OppCard";
import { oppError, useOppMutation, type OppDetail } from "./shared";

/** The journal of an opportunity: its notes in order, and a box to add one (kept as typed until sent). */
export function OppJournal({ o }: { o: OppDetail }) {
  const { t } = useTranslation();
  const can = useCan();
  const [text, setText, clearText] = useDraft(`opp:${o.id}:note`);
  const add = useOppMutation(
    () => api.post(`/opps/${o.id}/notes`, { text: text.trim() }),
    () => {
      clearText();
      toast.success(t("opps.detail.noteAdded"));
    },
    (e) => toast.error(oppError(e, t)),
  );

  return (
    <Card title={t("opps.detail.journal")}>
      {o.notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("opps.detail.journalNone")}</p>
      ) : (
        <ol className="space-y-2">
          {o.notes.map((n) => {
            const system = !n.author || n.kind === "system";
            return (
              <li key={n.id} className={system ? "rounded-lg px-3 py-1.5 text-xs italic text-muted-foreground" : "rounded-lg border bg-background/40 px-3 py-2 text-sm"}>
                <div className="mb-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground/80">{n.author ?? t("opps.detail.system")}</span>
                  <span>{relativeTime(n.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words">{n.text}</p>
              </li>
            );
          })}
        </ol>
      )}
      {can("opps.create") && (
        <div className="space-y-2 pt-2">
          <AiTextarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("opps.detail.notePlaceholder")} aria-label={t("opps.detail.noteLabel")} />
          <div className="flex justify-end">
            <Button size="sm" onClick={() => add.mutate()} disabled={!text.trim() || add.isPending}>
              {add.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("opps.detail.noteAdd")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
