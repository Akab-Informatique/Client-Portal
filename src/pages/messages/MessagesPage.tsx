import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Building2, ChevronDown, Eye, Mail, Megaphone, MoreHorizontal, Pin, PinOff, Plus, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { dateTime, relativeTime } from "@/lib/format";
import type { Message } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Composer } from "./Composer";
import { useDeepLink } from "@/lib/useDeepLink";

export function MessagesPage() {
  const { t } = useTranslation();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<"all" | "pinned">("all");
  const composeOpen = params.get("compose") === "1";
  const setCompose = (open: boolean) =>
    setParams((p) => {
      if (open) p.set("compose", "1");
      else p.delete("compose");
      return p;
    });

  const { data, isLoading } = useQuery({ queryKey: ["messages"], queryFn: () => api.get<Message[]>("/messages") });
  const list = useMemo(() => (data ?? []).filter((m) => filter === "all" || m.pinned), [data, filter]);
  const highlight = useDeepLink("message", "msg-", Boolean(data));

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl border bg-card p-6 sm:p-8">
        <div className="pointer-events-none absolute -right-20 -top-20 size-64 rounded-full blur-3xl" style={{ background: "radial-gradient(circle, var(--glow), transparent 70%)" }} />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-3 inline-flex size-10 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204] glow-gold">
              <Megaphone className="size-5" />
            </div>
            <h1 className="text-3xl font-bold">{t("messages.title")}</h1>
            <p className="mt-1 text-muted-foreground">{t("messages.subtitle")}</p>
          </div>
          {can("messages.post") && (
            <Button onClick={() => setCompose(true)} className="h-10 bg-grad-gold font-semibold text-[#1a1204] glow-gold hover:brightness-105">
              <Plus className="size-4" /> {t("messages.new")}
            </Button>
          )}
        </div>
      </div>

      <Tabs value={filter} onValueChange={(v) => setFilter(v as "all" | "pinned")}>
        <TabsList>
          <TabsTrigger value="all">{t("messages.filterAll")} {data && <span className="ml-1 text-muted-foreground">{data.length}</span>}</TabsTrigger>
          <TabsTrigger value="pinned">
            <Pin className="size-3.5" /> {t("messages.filterPinned")} {data && <span className="ml-1 text-muted-foreground">{data.filter((m) => m.pinned).length}</span>}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 rounded-2xl" />)}</div>
      ) : list.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-14 text-center text-muted-foreground">{t("messages.empty")}</div>
      ) : (
        <motion.ul layout className="space-y-3">
          <AnimatePresence initial={false}>
            {list.map((m) => (
              <MessageCard key={m.id} m={m} highlight={highlight === m.id} />
            ))}
          </AnimatePresence>
        </motion.ul>
      )}

      {can("messages.post") && <Composer open={composeOpen} onOpenChange={setCompose} />}
    </div>
  );
}

function MessageCard({ m, highlight }: { m: Message; highlight: boolean }) {
  const { t } = useTranslation();
  const can = useCan();
  const me = useMe();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const long = m.body.length > 280 || m.body.split("\n").length > 4;

  const update = useMutation({
    mutationFn: (pinned: boolean) => api.patch<Message>(`/messages/${m.id}`, { pinned }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["messages"] }),
    onError: () => toast.error(t("common.error")),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/messages/${m.id}`),
    onSuccess: () => {
      toast.success(t("messages.deleted"));
      void qc.invalidateQueries({ queryKey: ["messages"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: () => toast.error(t("common.error")),
  });
  const canDelete = can("messages.manage") || (m.authorId === me.id && can("messages.post"));

  // Email copies are sent in the background — refresh once to show the count
  useEffect(() => {
    if (!m.emailCopy || m.emailSent > 0) return;
    const id = setTimeout(() => void qc.invalidateQueries({ queryKey: ["messages"] }), 3000);
    return () => clearTimeout(id);
  }, [m.emailCopy, m.emailSent, qc]);

  return (
    <motion.li
      id={`msg-${m.id}`}
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-card/80 p-5 transition-colors",
        m.pinned ? "border-[color:var(--gold)]/40 ring-gold" : "hover:border-foreground/15",
        highlight && "scale-[1.01] border-[color:var(--gold)] shadow-[0_0_0_3px_rgba(255,206,26,0.35),0_0_40px_-8px_rgba(255,206,26,0.6)] transition-all duration-500",
      )}
    >
      {m.pinned && <div className="absolute inset-y-0 left-0 w-1 bg-grad-gold" />}
      <div className="flex items-start gap-4">
        <div className={cn("mt-0.5 hidden size-10 shrink-0 items-center justify-center rounded-xl sm:flex", m.pinned ? "bg-grad-gold text-[#1a1204]" : "bg-muted text-muted-foreground")}>
          {m.pinned ? <Pin className="size-4" /> : <Megaphone className="size-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold">{m.title}</h3>
            {m.pinned && <Badge className="bg-grad-gold text-[#1a1204]">{t("messages.pinned")}</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground" title={dateTime(m.createdAt)}>
            {m.author ? `${t("messages.by", { name: m.author })} · ` : ""}
            {relativeTime(m.createdAt)}
          </p>
          <div className={cn("mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90", !expanded && long && "line-clamp-4")}>{m.body}</div>
          {long && (
            <button type="button" onClick={() => setExpanded((e) => !e)} className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
              <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
              {expanded ? "−" : "+"}
            </button>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
            {m.audience === "all" ? (
              <Badge variant="outline" className="gap-1">
                <Users className="size-3" /> {t("messages.toAll")}
              </Badge>
            ) : (
              <>
                {m.clients.slice(0, 3).map((c) => (
                  <Badge key={c.id} variant="outline" className="gap-1">
                    <Building2 className="size-3" /> {c.name}
                  </Badge>
                ))}
                {m.clients.length > 3 && <Badge variant="outline">+{m.clients.length - 3}</Badge>}
              </>
            )}
            {m.emailCopy && (
              <Badge variant="secondary" className="gap-1">
                <Mail className="size-3" /> {t("messages.emailed", { count: m.emailSent })}
              </Badge>
            )}
            <Badge variant="secondary" className="gap-1">
              <Eye className="size-3" /> {t("messages.reads", { count: m.readCount })}
            </Badge>
          </div>
        </div>
        {(can("messages.pin") || canDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0 opacity-60 group-hover:opacity-100" aria-label="Actions">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {can("messages.pin") && (
                <DropdownMenuItem onSelect={() => update.mutate(!m.pinned)}>
                  {m.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                  {m.pinned ? t("messages.unpin") : t("messages.pinAction")}
                </DropdownMenuItem>
              )}
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      if (window.confirm(t("messages.deleteConfirm"))) remove.mutate();
                    }}
                  >
                    <Trash2 className="size-4" /> {t("common.delete")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </motion.li>
  );
}
