import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight, FileText, Loader2, Mail } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card } from "./BillingSection";
import { TemplateEditor } from "./EmailSection";

type Settings = { autoSend: boolean; remindersAuto: boolean; remindersFrom: string | null; levels: number[]; levelsAvailable: number[]; lastRun: string | null };
type Summary = { key: string; variables: string[]; edited: { fr: boolean; en: boolean } };
const KEY = ["admin", "billing", "email"];
const ORDER = ["invoiceSent", "invoicePastDue", "invoiceReminder5", "invoiceReminder15", "invoiceReminder20", "invoiceReminder30", "invoiceReminder60", "invoiceReminder90", "accountStatement"];

/** Admin › Facturation › Courriels: when invoicing emails go out, and their texts (?mtemplate=<key> opens the editor). */
export function BillingMailTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const open = params.get("mtemplate");
  const go = (key: string | null) =>
    setParams(
      (p) => {
        if (key) p.set("mtemplate", key);
        else p.delete("mtemplate");
        return p;
      },
      { replace: true },
    );
  const settings = useQuery({ queryKey: [...KEY, "settings"], queryFn: () => api.get<Settings>("/billing/email/settings") });
  const templates = useQuery({ queryKey: [...KEY, "templates"], queryFn: () => api.get<Summary[]>("/billing/email/templates") });
  const save = useMutation({
    mutationFn: (p: Partial<Pick<Settings, "autoSend" | "remindersAuto" | "levels" | "remindersFrom">>) => api.put<Settings>("/billing/email/settings", p),
    onSuccess: (s) => {
      qc.setQueryData([...KEY, "settings"], s);
      toast.success(t("billing.mail.saved"));
    },
    onError: () => toast.error(t("common.error")),
  });
  if (open) return <TemplateEditor tkey={open} base="/billing/email" onBack={() => go(null)} />;
  const s = settings.data;
  const toggleLevel = (n: number) => s && save.mutate({ levels: s.levels.includes(n) ? s.levels.filter((x) => x !== n) : [...s.levels, n].sort((a, b) => a - b) });
  return (
    <div className="space-y-6">
      <Card title={t("billing.mail.title")} text={t("billing.mail.text")}>
        {!s ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-4">
            <label className="flex items-start gap-3 text-sm">
              <Switch checked={s.autoSend} disabled={save.isPending} onCheckedChange={(v) => save.mutate({ autoSend: v })} />
              <span>
                <span className="block font-medium">{t("billing.mail.autoSend")}</span>
                <span className="block text-xs text-muted-foreground">{t("billing.mail.autoSendText")}</span>
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <Switch checked={s.remindersAuto} disabled={save.isPending} onCheckedChange={(v) => save.mutate({ remindersAuto: v })} />
              <span>
                <span className="block font-medium">{t("billing.mail.remindersAuto")}</span>
                <span className="block text-xs text-muted-foreground">{t("billing.mail.remindersAutoText")}</span>
                {s.lastRun && <span className="mt-0.5 block text-[11px] text-muted-foreground">{t("billing.mail.lastRun", { date: s.lastRun })}</span>}
              </span>
            </label>
            <label className="block max-w-xs space-y-1 text-xs">
              <span className="text-muted-foreground">{t("billing.mail.from")}</span>
              <Input type="date" value={s.remindersFrom ?? ""} disabled={save.isPending} onChange={(e) => save.mutate({ remindersFrom: e.target.value || null })} />
              <span className="block text-[10px] leading-snug text-muted-foreground">{t("billing.mail.fromText")}</span>
            </label>
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">{t("billing.mail.levels")}</p>
              <div className="flex flex-wrap gap-1.5">
                {s.levelsAvailable.map((n) => {
                  const on = s.levels.includes(n);
                  return (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={on}
                      disabled={save.isPending}
                      onClick={() => toggleLevel(n)}
                      className={cn("h-8 rounded-full border px-3 text-xs transition-colors", on ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50")}
                    >
                      {t(n >= 30 ? "billing.mail.levelPlus" : "billing.mail.level", { days: n })}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card title={t("billing.mail.templates")} text={t("billing.mail.templatesText")}>
        <div className="grid gap-3 sm:grid-cols-2">
          {!templates.data
            ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-2xl" />)
            : [...templates.data].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key)).map((tpl) => {
                const edited = tpl.edited.fr || tpl.edited.en;
                const Icon = tpl.key === "accountStatement" ? FileText : Mail;
                return (
                  <button
                    key={tpl.key}
                    type="button"
                    onClick={() => go(tpl.key)}
                    className="group flex items-start gap-3 rounded-2xl border bg-card/60 p-3.5 text-left transition-all hover:-translate-y-0.5 hover:border-[color:var(--gold)]/40"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[color:var(--gold)]/10 text-primary">
                      <Icon className="size-4.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {t(`email.templates.names.${tpl.key}`)}
                        <Badge variant="outline" className={cn("h-5 text-[10px]", edited ? "border-[color:var(--gold)]/50 text-primary" : "text-muted-foreground")}>
                          {edited ? t("billing.mail.edited") : t("billing.mail.default")}
                        </Badge>
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{t(`email.templates.descriptions.${tpl.key}`)}</span>
                    </span>
                    <ChevronRight className="mt-2 size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </button>
                );
              })}
        </div>
      </Card>
    </div>
  );
}

