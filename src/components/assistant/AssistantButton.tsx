import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RotateCcw, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { AssistantText } from "./AssistantText";

/** One message of the conversation. Kept in this component only: nothing is stored. */
type Turn = { role: "user" | "assistant"; content: string; sources?: string[]; tools?: string[]; error?: string };
type Reply = { answer: string; sources: string[]; tools: string[] };

/** The server takes at most 12 messages, the last one a question. */
const MAX_TURNS = 12;

/**
 * The portal assistant: a round gold "IA" button (for the top bar) that opens a panel on the right with the
 * conversation. Only shown to people who may use the assistant (assistant.use).
 */
export function AssistantButton() {
  const { t } = useTranslation();
  const can = useCan();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, busy]);

  if (!can("assistant.use")) return null;

  const errorText = (code: string) => {
    const key = code.replace(/^ai_/, "");
    return t(`assistant.errors.${key}`, { defaultValue: t("assistant.errors.generic") });
  };

  async function send(question?: string) {
    const q = (question ?? text).trim();
    if (!q || busy) return;
    // the conversation as the server expects it: the latest messages, the first one a question, ending with this one
    const history = [...turns.filter((x) => !x.error), { role: "user" as const, content: q }].map(({ role, content }) => ({ role, content }));
    let windowed = history.slice(-MAX_TURNS);
    while (windowed.length && windowed[0].role !== "user") windowed = windowed.slice(1);
    setTurns((prev) => [...prev, { role: "user", content: q }]);
    setText("");
    setBusy(true);
    try {
      const r = await api.post<Reply>("/assistant/chat", { messages: windowed });
      setTurns((prev) => [...prev, { role: "assistant", content: r.answer, sources: r.sources, tools: r.tools }]);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      setTurns((prev) => [...prev, { role: "assistant", content: "", error: errorText(code) }]);
    } finally {
      setBusy(false);
    }
  }

  const examples = [t("assistant.example1"), t("assistant.example2"), t("assistant.example3")];

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          className="h-9 gap-1.5 rounded-full bg-grad-gold px-3 text-[#1a1204] hover:brightness-105"
          aria-label={t("assistant.open")}
          title={t("assistant.open")}
        >
          <Sparkles className="size-4" />
          <span className="text-xs font-semibold tracking-wide">{t("assistant.button")}</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="flex-row items-center justify-between gap-2 border-b px-4 py-3">
          <div className="min-w-0">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-primary" /> {t("assistant.title")}
            </SheetTitle>
            <SheetDescription className="sr-only">{t("assistant.intro")}</SheetDescription>
          </div>
          <Button variant="ghost" size="sm" className="shrink-0 gap-1.5" onClick={() => { setTurns([]); setText(""); }} disabled={busy || !turns.length}>
            <RotateCcw className="size-3.5" /> {t("assistant.newConversation")}
          </Button>
        </SheetHeader>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {!turns.length ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{t("assistant.intro")}</p>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("assistant.examples")}</p>
              <div className="flex flex-col gap-2">
                {examples.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => void send(ex)}
                    className="rounded-lg border bg-card px-3 py-2 text-left text-sm hover:border-primary/60"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {turns.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="ml-8 rounded-2xl rounded-br-sm bg-primary/15 px-3 py-2 text-sm">
                <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">{t("assistant.you")}</div>
                <p className="whitespace-pre-wrap">{m.content}</p>
              </div>
            ) : (
              <div key={i} className="mr-6 rounded-2xl rounded-bl-sm border bg-card px-3 py-2">
                <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">{t("assistant.assistantName")}</div>
                {m.error ? <p className="text-sm text-destructive">{m.error}</p> : <AssistantText text={m.content} />}
                {m.tools?.length ? (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {t("assistant.tools")} : {m.tools.map((n) => t(`assistant.tool.${n}`, { defaultValue: n })).join(", ")}
                  </p>
                ) : null}
                {m.sources?.length ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t("assistant.sources")} : {m.sources.join(" · ")}
                  </p>
                ) : null}
              </div>
            ),
          )}

          {busy ? (
            <div className="mr-6 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {t("assistant.thinking")}
            </div>
          ) : null}
          <div ref={endRef} />
        </div>

        <form
          className="border-t p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="flex items-end gap-2">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              maxLength={4000}
              placeholder={t("assistant.placeholder")}
              aria-label={t("assistant.placeholder")}
              className="min-h-10 resize-none"
            />
            <Button type="submit" size="icon" className="size-10 shrink-0 bg-grad-gold text-[#1a1204] hover:brightness-105" disabled={busy || !text.trim()} aria-label={t("assistant.send")} title={t("assistant.send")}>
              <Send className="size-4" />
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">{t("assistant.hint")}</p>
        </form>
      </SheetContent>
    </Sheet>
  );
}
