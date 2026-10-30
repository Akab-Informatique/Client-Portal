import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, MessageSquarePlus, MessagesSquare, Users } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ChatNotice, ChatThread, useChatStatus } from "./ChatThread";

type Chat = { id: string; type: string; title: string; members: { name: string; email: string | null }[]; lastAt: string | null; preview: string; previewFrom: string | null };
type Colleague = { id: string; name: string; email: string };

/**
 * My tools › Chat: my own Microsoft Teams chats, in the portal. Written with my own Microsoft account only; every message is a
 * real Teams message, so a colleague can answer from Teams and I see it here (and the other way round).
 */
export function ChatPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const status = useChatStatus();
  const usable = Boolean(status.data?.ready && status.data.signedIn && !status.data.needsReconnect);
  const [picked, setPicked] = useState<string | null>(null);
  const chats = useQuery({ queryKey: ["chat", "chats"], queryFn: () => api.get<Chat[]>("/chat/chats"), enabled: usable, refetchInterval: 15_000 });
  const colleagues = useQuery({ queryKey: ["chat", "colleagues"], queryFn: () => api.get<Colleague[]>("/chat/colleagues"), enabled: usable, staleTime: 5 * 60_000 });
  const open = useMutation({
    mutationFn: (colleagueId: string) => api.post<{ id: string }>("/chat/chats", { colleagueId }),
    onSuccess: (r) => {
      setPicked(r.id);
      void qc.invalidateQueries({ queryKey: ["chat", "chats"] });
    },
    onError: () => toast.error(t("common.error")),
  });
  const current = chats.data?.find((c) => c.id === picked);
  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <MessagesSquare className="size-6 text-primary" /> {t("chat.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("chat.subtitle")}</p>
      </div>
      <ChatNotice status={status.data} />
      {usable && (
        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="glass space-y-3 rounded-2xl border p-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <MessageSquarePlus className="size-4 text-primary" />
              <select
                value=""
                disabled={open.isPending}
                onChange={(e) => e.target.value && open.mutate(e.target.value)}
                className="h-9 flex-1 rounded-md border bg-transparent px-2 text-sm text-foreground"
                aria-label={t("chat.newChat")}
              >
                <option value="">{t("chat.newChat")}</option>
                {(colleagues.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {chats.isLoading && <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />}
            <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
              {(chats.data ?? []).map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => setPicked(c.id)} className={cn("w-full rounded-xl border px-3 py-2 text-left transition-colors hover:border-[color:var(--gold)]/40", picked === c.id ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10" : "border-transparent")}>
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {c.type !== "oneOnOne" && <Users className="size-3.5 text-muted-foreground" />}
                      <span className="truncate">{c.title}</span>
                    </span>
                    {c.preview && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {c.previewFrom ? `${c.previewFrom} : ` : ""}
                        {c.preview}
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {chats.data && chats.data.length === 0 && <li className="py-4 text-center text-xs text-muted-foreground">{t("chat.noChats")}</li>}
            </ul>
          </aside>
          <section className="glass flex min-h-[24rem] flex-col rounded-2xl border p-4">
            {picked ? (
              <>
                <h2 className="mb-2 text-sm font-semibold">{current?.title ?? t("chat.title")}</h2>
                <ChatThread chatId={picked} />
              </>
            ) : (
              <p className="m-auto text-sm text-muted-foreground">{t("chat.pick")}</p>
            )}
          </section>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">{t("chat.privacy")}</p>
    </div>
  );
}
