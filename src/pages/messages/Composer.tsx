import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, Check, Loader2, Mail, Pin, Search, Send, Users } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AiTextarea } from "@/components/AiPolish";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import type { ClientOption, Message } from "@/lib/types";
import { cn } from "@/lib/utils";

export function Composer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<"all" | "selected">("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [pinned, setPinned] = useState(false);
  const [emailCopy, setEmailCopy] = useState(false);

  const { data: clients } = useQuery({
    queryKey: ["client-options"],
    queryFn: () => api.get<ClientOption[]>("/messages/client-options"),
    enabled: open,
  });

  const recipients = useMemo(() => {
    const pool = audience === "all" ? (clients ?? []) : (clients ?? []).filter((c) => selected.includes(c.id));
    return pool.reduce((n, c) => n + c.notifyCount, 0);
  }, [clients, audience, selected]);

  const filtered = (clients ?? []).filter((c) => `${c.name} ${c.code ?? ""}`.toLowerCase().includes(search.toLowerCase()));

  const send = useMutation({
    mutationFn: () =>
      api.post<Message>("/messages", { title, body, audience, clientIds: audience === "selected" ? selected : [], pinned, emailCopy }),
    onSuccess: () => {
      toast.success(emailCopy ? t("messages.sentEmail") : t("messages.sent"));
      void qc.invalidateQueries({ queryKey: ["messages"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      setTitle("");
      setBody("");
      setAudience("all");
      setSelected([]);
      setPinned(false);
      setEmailCopy(false);
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "no_clients" ? t("messages.noClients") : t("common.error")),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (audience === "selected" && !selected.length) return toast.error(t("messages.noClients"));
    send.mutate();
  }

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <SheetHeader className="border-b p-6">
          <SheetTitle className="font-display text-xl">{t("messages.compose")}</SheetTitle>
          <SheetDescription>{t("messages.subtitle")}</SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} className="space-y-6 p-6">
          <div className="space-y-2">
            <Label htmlFor="m-title">{t("messages.titleLabel")}</Label>
            <Input id="m-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("messages.titlePlaceholder")} />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="m-body">{t("messages.body")}</Label>
              <span className="font-mono text-[11px] text-muted-foreground">{body.length} / 10000</span>
            </div>
            <AiTextarea id="m-body" required maxLength={10000} rows={7} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("messages.bodyPlaceholder")} />
          </div>

          <div className="space-y-3">
            <Label>{t("messages.recipients")}</Label>
            <div className="grid grid-cols-2 gap-2">
              {(["all", "selected"] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAudience(a)}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border p-3 text-left text-sm transition-colors",
                    audience === a ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10" : "hover:bg-accent/50",
                  )}
                >
                  <span className={cn("flex size-8 items-center justify-center rounded-lg", audience === a ? "bg-grad-gold text-[#1a1204]" : "bg-muted")}>
                    {a === "all" ? <Users className="size-4" /> : <Building2 className="size-4" />}
                  </span>
                  <span className="font-medium">{a === "all" ? t("messages.allClients") : t("messages.selectedClients")}</span>
                </button>
              ))}
            </div>
            {audience === "selected" && (
              <div className="rounded-xl border">
                <div className="flex items-center gap-2 border-b px-3">
                  <Search className="size-4 text-muted-foreground" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("common.search")}
                    className="h-10 flex-1 bg-transparent text-sm outline-none"
                  />
                  <span className="text-xs text-muted-foreground">{t("messages.selectedCount", { count: selected.length })}</span>
                </div>
                <ul className="max-h-56 overflow-y-auto p-1 scrollbar-thin">
                  {filtered.map((c) => (
                    <li key={c.id}>
                      <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm hover:bg-accent/50">
                        <Checkbox checked={selected.includes(c.id)} onCheckedChange={() => toggle(c.id)} />
                        <span className="flex-1">{c.name}</span>
                        {c.code && <span className="font-mono text-[11px] text-muted-foreground">{c.code}</span>}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {(can("messages.pin") || can("messages.email")) && (
            <div className="space-y-2">
              <Label>{t("messages.options")}</Label>
              {can("messages.pin") && (
                <label className="flex items-start gap-3 rounded-xl border p-3">
                  <Pin className="mt-0.5 size-4 text-primary" />
                  <span className="flex-1">
                    <span className="block text-sm font-medium">{t("messages.pin")}</span>
                    <span className="block text-xs text-muted-foreground">{t("messages.pinHint")}</span>
                  </span>
                  <Switch checked={pinned} onCheckedChange={setPinned} />
                </label>
              )}
              {can("messages.email") && (
                <label className="flex items-start gap-3 rounded-xl border p-3">
                  <Mail className="mt-0.5 size-4 text-primary" />
                  <span className="flex-1">
                    <span className="block text-sm font-medium">{t("messages.emailCopy")}</span>
                    <span className="block text-xs text-muted-foreground">{t("messages.emailCopyHint", { count: recipients })}</span>
                  </span>
                  <Switch checked={emailCopy} onCheckedChange={setEmailCopy} />
                </label>
              )}
            </div>
          )}

          {(title || body) && (
            <div className="space-y-2">
              <Label>{t("messages.preview")}</Label>
              <div className={cn("rounded-xl border bg-background p-4", pinned && "border-[color:var(--gold)]/50")}>
                <div className="flex items-center gap-2">
                  {pinned && <Pin className="size-3.5 text-primary" />}
                  <p className="font-display font-semibold">{title || "…"}</p>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{body || "…"}</p>
              </div>
            </div>
          )}

          <div className="sticky bottom-0 -mx-6 -mb-6 flex justify-end gap-2 border-t bg-background/90 p-4 backdrop-blur">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={send.isPending} className="bg-grad-gold font-semibold text-[#1a1204] glow-gold hover:brightness-105">
              {send.isPending ? <Loader2 className="size-4 animate-spin" /> : emailCopy ? <Mail className="size-4" /> : <Send className="size-4" />}
              {send.isPending ? t("messages.sending") : t("messages.send")}
              {!send.isPending && audience === "selected" && selected.length > 0 && (
                <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-black/10 px-1.5 text-xs">
                  <Check className="size-3" /> {selected.length}
                </span>
              )}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
