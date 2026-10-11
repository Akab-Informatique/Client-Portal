import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { LogOut, Megaphone, Pin } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { TechBackground } from "@/components/brand/TechBackground";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ViewAsBanner, ViewSwitcher } from "@/components/ViewSwitcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { signOut, useMe } from "@/lib/session";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type BoardMessage = { id: string; title: string; body: string; pinned: boolean; createdAt: string; read: boolean };

/** Interim client space: the message board receiver. The full client layout comes next. */
export function ClientHome() {
  const { t } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["board"], queryFn: () => api.get<BoardMessage[]>("/board") });
  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/board/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board"] }),
  });
  return (
    <div className="min-h-dvh">
      <div className="sticky top-0 z-30">
      <ViewAsBanner />
      <header className="flex h-16 items-center gap-3 border-b bg-background/80 px-5 backdrop-blur-xl">
        <Logo />
        <span className="ml-2 hidden text-sm text-muted-foreground sm:inline">{me.client?.name}</span>
        {me.viewAs && <ViewSwitcher className="ml-2" />}
        <div className="ml-auto flex items-center gap-2">
          <LanguageToggle persist={!me.viewAs} />
          {!me.viewAs && (
            <Button variant="ghost" size="sm" onClick={() => void signOut(qc)}>
              <LogOut className="size-4" /> {t("topbar.signOut")}
            </Button>
          )}
        </div>
      </header>
      </div>
      <div className="relative">
        <TechBackground intensity={0.5} className="h-72" />
        <div className="relative mx-auto max-w-3xl px-5 py-10">
          <h1 className="text-3xl font-bold">{t("client.welcome", { name: me.viewAs ? me.viewAs.clientName : me.name.split(" ")[0] })}</h1>
          <p className="mt-2 text-muted-foreground">{t("client.soon")}</p>
          <h2 className="mt-10 flex items-center gap-2 text-lg font-semibold">
            <Megaphone className="size-5 text-primary" /> {t("client.board")}
          </h2>
          <ul className="mt-4 space-y-3">
            {data.map((m, i) => (
              <motion.li
                key={m.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                onMouseEnter={() => !m.read && !me.viewAs && markRead.mutate(m.id)}
                className={cn("rounded-2xl border bg-card p-5", m.pinned && "border-[color:var(--gold)]/40 ring-gold")}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {m.pinned && <Pin className="size-4 text-primary" />}
                  <h3 className="font-semibold">{m.title}</h3>
                  {!m.read && <Badge className="bg-grad-gold text-[#1a1204]">{t("client.new")}</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground">{relativeTime(m.createdAt)}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{m.body}</p>
              </motion.li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
