import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useDraft } from "@/lib/useDraft";
import { hm, parseHm } from "@shared/duration";
import { Pane } from "./ui";
import { AttachButton } from "./DelegateFiles";
import { DELEGATE_API, useDelegateError } from "./delegateShared";
import type { NoteTimer } from "./useNoteTimer";

/** Minutes typed as h:mm: a number, or null when the text is not a time */
function minutesOf(text: string): number | null {
  const v = text.trim();
  if (!v) return 0;
  const h = parseHm(v);
  return h == null ? null : Math.round(h * 60);
}

/**
 * The public note box. The time worked is only noted (never billed): the field starts at the
 * stopwatch's whole minutes and follows it until the delegate types a value by hand.
 */
export function Composer({ ticketId, timer, onChanged }: { ticketId: number; timer: NoteTimer; onChanged: () => void }) {
  const { t } = useTranslation();
  const errorText = useDelegateError();
  const [text, setText, clearText] = useDraft(`delegate-ticket:${ticketId}:public`);
  const [timeText, setTimeText] = useState("");
  const [timeTouched, setTimeTouched] = useState(false);

  const autoTime = hm(Math.floor(timer.seconds / 60) / 60);
  const shownTime = timeTouched ? timeText : autoTime;
  const minutes = minutesOf(shownTime);
  const invalidTime = minutes == null;
  const trimmed = text.trim();

  const send = useMutation({
    mutationFn: (noted: number) => {
      const body: Record<string, unknown> = { text: trimmed };
      if (noted > 0) body.workedMinutes = noted;
      return api.post<{ ok: boolean }>(`${DELEGATE_API}/tickets/${ticketId}/notes`, body);
    },
    onSuccess: () => {
      clearText();
      setTimeText("");
      setTimeTouched(false);
      timer.restart();
      toast.success(t("selfManaged.delegate.ticket.compose.sent"));
      onChanged();
    },
    onError: (e) => toast.error(errorText(e)),
  });

  const sendNow = () => {
    if (trimmed && minutes != null && !send.isPending) send.mutate(minutes);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      sendNow();
    }
  };

  return (
    <Pane className="space-y-3 p-4">
      <label htmlFor={`delegate-note-${ticketId}`} className="text-sm font-medium">
        {t("selfManaged.delegate.ticket.compose.label")}
      </label>
      <Textarea
        id={`delegate-note-${ticketId}`}
        value={text}
        rows={4}
        maxLength={4000}
        placeholder={t("selfManaged.delegate.ticket.compose.placeholder")}
        aria-describedby={`delegate-note-hint-${ticketId}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <p id={`delegate-note-hint-${ticketId}`} className="text-xs text-muted-foreground">
        {t("selfManaged.delegate.ticket.compose.hint")}
      </p>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor={`delegate-time-${ticketId}`} className="text-xs font-medium">
              {t("selfManaged.delegate.ticket.compose.timeLabel")}
            </label>
            <Input
              id={`delegate-time-${ticketId}`}
              value={shownTime}
              inputMode="numeric"
              maxLength={7}
              aria-invalid={invalidTime}
              aria-describedby={`delegate-time-hint-${ticketId}`}
              onChange={(e) => {
                setTimeTouched(true);
                setTimeText(e.target.value);
              }}
              className="h-9 w-24 font-mono tabular-nums"
            />
            <p id={`delegate-time-hint-${ticketId}`} className={invalidTime ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {invalidTime ? t("selfManaged.delegate.ticket.compose.timeInvalid") : t("selfManaged.delegate.ticket.compose.timeHint")}
            </p>
          </div>
          <AttachButton ticketId={ticketId} onDone={onChanged} />
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground md:inline">{t("selfManaged.delegate.ticket.compose.sendHint")}</span>
          <Button type="button" onClick={sendNow} disabled={!trimmed || invalidTime || send.isPending}>
            {send.isPending ? t("selfManaged.delegate.ticket.compose.sending") : t("selfManaged.delegate.ticket.compose.send")}
          </Button>
        </div>
      </div>
    </Pane>
  );
}
