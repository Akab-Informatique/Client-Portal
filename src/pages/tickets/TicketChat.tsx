import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";
import { ChatNotice, ChatThread, useChatStatus } from "@/pages/chat/ChatThread";
import type { TicketDetail } from "./shared";

type Colleague = { id: string; name: string; email: string };

/**
 * A small chat in the ticket window: pick a colleague and talk to them straight away. It is the colleague's Teams chat with me
 * (the same one as in My tools › Chat): they answer from Teams if they are not in the portal. The ticket number is offered as the
 * first words so they know what it is about.
 */
export function TicketChat({ tk }: { tk: Pick<TicketDetail, "number" | "title"> }) {
  const { t } = useTranslation();
  const me = useMe();
  const status = useChatStatus();
  const usable = Boolean(status.data?.ready && status.data.signedIn && !status.data.needsReconnect);
  const [chatId, setChatId] = useState<string | null>(null);
  const colleagues = useQuery({ queryKey: ["chat", "colleagues"], queryFn: () => api.get<Colleague[]>("/chat/colleagues"), enabled: usable, staleTime: 5 * 60_000 });
  const open = useMutation({
    mutationFn: (colleagueId: string) => api.post<{ id: string }>("/chat/chats", { colleagueId }),
    onSuccess: (r) => setChatId(r.id),
    onError: () => toast.error(t("common.error")),
  });
  if (!me.permissions.includes("chat.use")) return null;
  if (!usable) return <ChatNotice status={status.data} />;
  return (
    <div className="space-y-2">
      <select
        defaultValue=""
        disabled={open.isPending}
        onChange={(e) => (e.target.value ? open.mutate(e.target.value) : setChatId(null))}
        className="h-8 w-full rounded-md border bg-transparent px-2 text-sm"
        aria-label={t("chat.pickColleague")}
      >
        <option value="">{t("chat.pickColleague")}</option>
        {(colleagues.data ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {open.isPending && <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />}
      {chatId && <ChatThread chatId={chatId} compact prefill={`${tk.number} — ${tk.title} : `} />}
    </div>
  );
}
