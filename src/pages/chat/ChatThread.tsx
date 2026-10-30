import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Paperclip, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

export type ChatStatus = { ready: boolean; signedIn: boolean; email: string | null; needsReconnect: boolean };
export type ChatMessage = { id: string; at: string; from: string; mine: boolean; text: string; files: string[] };

export const useChatStatus = () => useQuery({ queryKey: ["chat", "status"], queryFn: () => api.get<ChatStatus>("/chat/status"), staleTime: 60_000 });

/** Why the chat cannot be used yet, in words (null: it can) */
export function ChatNotice({ status }: { status: ChatStatus | undefined }) {
  const { t } = useTranslation();
  if (!status) return null;
  const msg = !status.ready ? "chat.notReady" : !status.signedIn ? "chat.signIn" : status.needsReconnect ? "chat.reconnect" : null;
  return msg ? <p className="rounded-xl border border-orange-400/30 bg-orange-400/10 p-3 text-sm text-orange-200">{t(msg)}</p> : null;
}

/** One chat: its messages (refreshed every few seconds) and the box to answer. What is written is a real Teams message. */
export function ChatThread({ chatId, prefill, compact }: { chatId: string; prefill?: string; compact?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [text, setText] = useState(prefill ?? "");
  useEffect(() => setText(prefill ?? ""), [chatId, prefill]);
  const bottom = useRef<HTMLDivElement>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["chat", "messages", chatId],
    queryFn: () => api.get<ChatMessage[]>(`/chat/chats/${encodeURIComponent(chatId)}/messages`),
    refetchInterval: 5_000,
  });
  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [data?.length, chatId]);
  const send = useMutation({
    mutationFn: () => api.post(`/chat/chats/${encodeURIComponent(chatId)}/messages`, { text }),
    onSuccess: () => {
      setText("");
      void qc.invalidateQueries({ queryKey: ["chat"] });
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "chat_reconnect" ? t("chat.reconnect") : t("common.error")),
  });
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className={cn("min-h-0 flex-1 space-y-2 overflow-y-auto rounded-xl border bg-background/30 p-2", compact ? "max-h-64" : "max-h-[60vh]")}>
        {isLoading && <Loader2 className="mx-auto my-4 size-4 animate-spin text-muted-foreground" />}
        {error && <p className="text-xs text-destructive">{t("chat.loadFailed")}</p>}
        {data && data.length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">{t("chat.empty")}</p>}
        {(data ?? []).map((m) => (
          <div key={m.id} className={cn("flex", m.mine ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[85%] rounded-2xl px-3 py-1.5 text-sm", m.mine ? "bg-[color:var(--gold)]/15" : "bg-muted/60")}>
              {!m.mine && <p className="text-[10px] font-semibold text-muted-foreground">{m.from}</p>}
              {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
              {m.files.map((f) => (
                <p key={f} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Paperclip className="size-3" /> {f}
                </p>
              ))}
              <p className="text-right text-[9px] text-muted-foreground">{time(m.at)}</p>
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) send.mutate();
        }}
      >
        <Textarea
          rows={compact ? 1 : 2}
          value={text}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (text.trim() && !send.isPending) send.mutate();
            }
          }}
          placeholder={t("chat.placeholder")}
          className="min-h-9 resize-none"
        />
        <Button type="submit" size="icon" disabled={!text.trim() || send.isPending} className="size-9 shrink-0 bg-grad-gold text-[#1a1204]" aria-label={t("chat.send")}>
          {send.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </form>
    </div>
  );
}
