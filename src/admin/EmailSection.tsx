import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  FileText,
  KeyRound,
  Loader2,
  Mail,
  Megaphone,
  RotateCcw,
  Send,
  Server,
  ShieldCheck,
  UserPlus,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./sections";

type Smtp = {
  source: "database" | "env" | "none";
  host: string;
  port: number;
  security: "starttls" | "tls" | "none";
  user: string;
  hasPassword: boolean;
  from: string;
  fromName: string;
};
type TestResult = { ok: true; to: string } | { ok: false; error: "not_configured" | "connection" | "send"; detail?: string };
type TemplateSummary = { key: string; variables: string[]; edited: { fr: boolean; en: boolean } };
type Text = { subject: string; body: string; action: string };
type TemplateDetail = {
  key: string;
  variables: string[];
  hasButton: boolean;
  locales: Record<"fr" | "en", { current: Text; default: Text; edited: boolean }>;
};

const ICONS: Record<string, LucideIcon> = { welcome: UserPlus, passwordReset: KeyRound, passwordChanged: ShieldCheck, boardMessage: Megaphone };

/** Admin › Email: outgoing server and templates (?template=<key> opens the editor). */
export function EmailSection() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const open = params.get("template");
  const go = (key: string | null) =>
    setParams((p) => {
      if (key) p.set("template", key);
      else p.delete("template");
      return p;
    });

  if (open) return <TemplateEditor tkey={open} onBack={() => go(null)} />;
  return (
    <div className="space-y-8">
      <SectionHeader title={t("email.title")} subtitle={t("email.subtitle")} />
      <SmtpCard />
      <TemplateList onOpen={go} />
    </div>
  );
}

// ── SMTP ───────────────────────────────────────────────────────────────────────
function SmtpCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: s, isLoading } = useQuery({ queryKey: ["admin", "email", "smtp"], queryFn: () => api.get<Smtp>("/admin/email/smtp") });
  const [form, setForm] = useState({ host: "", port: "587", security: "starttls" as Smtp["security"], user: "", pass: "", from: "", fromName: "AKAB Informatique" });
  const [test, setTest] = useState<TestResult | null>(null);
  useEffect(() => {
    if (s) setForm({ host: s.host, port: String(s.port || 587), security: s.security, user: s.user, pass: "", from: s.from, fromName: s.fromName || "AKAB Informatique" });
  }, [s]);

  const save = useMutation({
    mutationFn: () =>
      api.put<Smtp>("/admin/email/smtp", {
        host: form.host.trim(),
        port: Number(form.port),
        security: form.security,
        user: form.user.trim(),
        ...(form.pass ? { pass: form.pass } : {}),
        from: form.from.trim(),
        fromName: form.fromName.trim(),
      }),
    onSuccess: (next) => {
      qc.setQueryData(["admin", "email", "smtp"], next);
      setTest(null);
      toast.success(t("common.saved"));
    },
    onError: () => toast.error(t("email.smtp.invalid")),
  });
  const clear = useMutation({
    mutationFn: () => api.del<Smtp>("/admin/email/smtp"),
    onSuccess: (next) => {
      qc.setQueryData(["admin", "email", "smtp"], next);
      setTest(null);
    },
  });
  const runTest = useMutation({
    mutationFn: () => api.post<TestResult>("/admin/email/smtp/test"),
    onSuccess: setTest,
    onError: () => toast.error(t("common.error")),
  });

  if (isLoading || !s) return <Skeleton className="h-72 rounded-2xl" />;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <section className="overflow-hidden rounded-2xl border bg-card/80">
      <div className="flex flex-wrap items-center gap-4 border-b px-6 py-5">
        <span className="flex size-11 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204] glow-gold">
          <Server className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold">{t("email.smtp.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("email.smtp.subtitle")}</p>
        </div>
        <Badge variant="outline" className={cn(s.source === "none" ? "text-muted-foreground" : "border-emerald-500/40 text-emerald-400")}>
          {t(`email.smtp.source.${s.source}`)}
        </Badge>
      </div>
      <form
        className="space-y-4 px-6 py-6"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-[1fr_120px_200px]">
          <Field id="smtp-host" label={t("email.smtp.host")}>
            <Input id="smtp-host" required value={form.host} onChange={set("host")} placeholder="smtp.office365.com" />
          </Field>
          <Field id="smtp-port" label={t("email.smtp.port")}>
            <Input id="smtp-port" required inputMode="numeric" value={form.port} onChange={set("port")} />
          </Field>
          <Field id="smtp-sec" label={t("email.smtp.security")}>
            <Select
              value={form.security}
              onValueChange={(v) => setForm({ ...form, security: v as Smtp["security"], port: v === "tls" ? "465" : form.port === "465" ? "587" : form.port })}
            >
              <SelectTrigger id="smtp-sec" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["starttls", "tls", "none"] as const).map((v) => (
                  <SelectItem key={v} value={v}>
                    {t(`email.smtp.securities.${v}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="smtp-user" label={t("email.smtp.user")}>
            <Input id="smtp-user" autoComplete="off" value={form.user} onChange={set("user")} />
          </Field>
          <Field id="smtp-pass" label={t("email.smtp.password")} saved={s.hasPassword}>
            <Input id="smtp-pass" type="password" autoComplete="new-password" value={form.pass} onChange={set("pass")} placeholder={s.hasPassword ? "••••••••••••" : ""} />
          </Field>
          <Field id="smtp-from" label={t("email.smtp.from")}>
            <Input id="smtp-from" type="email" required value={form.from} onChange={set("from")} placeholder="portail@akab.ca" />
          </Field>
          <Field id="smtp-name" label={t("email.smtp.fromName")}>
            <Input id="smtp-name" required value={form.fromName} onChange={set("fromName")} />
          </Field>
        </div>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <KeyRound className="size-3.5 text-primary" /> {t("email.smtp.note")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => runTest.mutate()} disabled={runTest.isPending || s.source === "none"}>
            {runTest.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("email.smtp.test")}
          </Button>
          <Button type="submit" disabled={save.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
          </Button>
          {s.source === "database" && (
            <Button type="button" variant="ghost" className="text-muted-foreground" onClick={() => window.confirm(t("email.smtp.clearConfirm")) && clear.mutate()}>
              <RotateCcw className="size-4" /> {t("email.smtp.clear")}
            </Button>
          )}
        </div>
        {test &&
          (test.ok ? (
            <p className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">
              <CheckCircle2 className="size-4" /> {t("email.smtp.testOk", { email: test.to })}
            </p>
          ) : (
            <p className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span>
                {t(`email.smtp.errors.${test.error}`)}
                {test.detail && <span className="mt-1 block font-mono text-xs text-muted-foreground">{test.detail}</span>}
              </span>
            </p>
          ))}
      </form>
    </section>
  );
}

function Field({ id, label, saved, children }: { id: string; label: string; saved?: boolean; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="flex items-center gap-2">
        {label}
        {saved && <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">{t("integrations.savedValue")}</span>}
      </Label>
      {children}
    </div>
  );
}

// ── Templates ───────────────────────────────────────────────────────────────────
function TemplateList({ onOpen }: { onOpen: (key: string) => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({ queryKey: ["admin", "email", "templates"], queryFn: () => api.get<TemplateSummary[]>("/admin/email/templates") });
  return (
    <section>
      <h3 className="mb-1 flex items-center gap-2 font-display text-lg font-semibold">
        <FileText className="size-5 text-primary" /> {t("email.templates.title")}
      </h3>
      <p className="mb-4 text-sm text-muted-foreground">{t("email.templates.subtitle")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {isLoading || !data
          ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)
          : data.map((tpl) => {
              const Icon = ICONS[tpl.key] ?? Mail;
              const edited = tpl.edited.fr || tpl.edited.en;
              return (
                <button
                  key={tpl.key}
                  type="button"
                  onClick={() => onOpen(tpl.key)}
                  className="group flex items-start gap-4 rounded-2xl border bg-card/80 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-[color:var(--gold)]/40"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[color:var(--gold)]/10 text-primary">
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 font-medium">
                      {t(`email.templates.names.${tpl.key}`)}
                      <Badge variant="outline" className={cn("h-5 text-[10px]", edited ? "border-[color:var(--gold)]/50 text-primary" : "text-muted-foreground")}>
                        {edited ? t("email.templates.edited") : t("email.templates.default")}
                      </Badge>
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{t(`email.templates.descriptions.${tpl.key}`)}</span>
                  </span>
                  <ChevronRight className="mt-2 size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </button>
              );
            })}
      </div>
    </section>
  );
}

function TemplateEditor({ tkey, onBack }: { tkey: string; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const key = ["admin", "email", "templates", tkey];
  const { data, isLoading, isError } = useQuery({ queryKey: key, queryFn: () => api.get<TemplateDetail>(`/admin/email/templates/${tkey}`) });
  const [locale, setLocale] = useState<"fr" | "en">(i18n.language === "en" ? "en" : "fr");
  const [draft, setDraft] = useState<Record<"fr" | "en", Text> | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (data) setDraft({ fr: data.locales.fr.current, en: data.locales.en.current });
  }, [data]);

  const text = draft?.[locale];
  const setText = (patch: Partial<Text>) => setDraft((d) => (d ? { ...d, [locale]: { ...d[locale], ...patch } } : d));
  const dirty = Boolean(data && draft && JSON.stringify(draft[locale]) !== JSON.stringify(data.locales[locale].current));

  // Live preview (debounced) rendered by the server with sample values
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const payload = useMemo(() => (text ? JSON.stringify(text) : ""), [text]);
  useEffect(() => {
    if (!text || !text.subject.trim() || !text.body.trim()) return;
    const id = setTimeout(() => {
      api
        .post<{ subject: string; html: string }>(`/admin/email/templates/${tkey}/${locale}/preview`, text)
        .then(setPreview)
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(id);
  }, [payload, locale, tkey]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["admin", "email", "templates"], exact: true });
  };
  const save = useMutation({
    mutationFn: () => api.put(`/admin/email/templates/${tkey}/${locale}`, text),
    onSuccess: () => {
      toast.success(t("common.saved"));
      refresh();
    },
    onError: () => toast.error(t("common.error")),
  });
  const reset = useMutation({
    mutationFn: () => api.del(`/admin/email/templates/${tkey}/${locale}`),
    onSuccess: () => {
      toast.success(t("email.templates.restored"));
      refresh();
    },
  });
  const sendTest = useMutation({
    mutationFn: () => api.post<TestResult>(`/admin/email/templates/${tkey}/${locale}/test`, text),
    onSuccess: (r) => (r.ok ? toast.success(t("email.smtp.testOk", { email: r.to })) : toast.error(t("email.smtp.errors.send"))),
    onError: () => toast.error(t("common.error")),
  });

  function insertVariable(v: string) {
    const el = bodyRef.current;
    if (!el || !text) return;
    const token = `{{${v}}}`;
    const start = el.selectionStart ?? text.body.length;
    const end = el.selectionEnd ?? start;
    setText({ body: text.body.slice(0, start) + token + text.body.slice(end) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  if (isError) return <p className="text-sm text-destructive">{t("common.error")}</p>;
  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2 mb-3 text-muted-foreground" onClick={onBack}>
          <ArrowLeft className="size-4" /> {t("email.title")}
        </Button>
        <SectionHeader title={t(`email.templates.names.${tkey}`)} subtitle={t(`email.templates.descriptions.${tkey}`)} />
      </div>
      {isLoading || !data || !text ? (
        <Skeleton className="h-96 rounded-2xl" />
      ) : (
        <div className="grid gap-6 xl:grid-cols-2">
          <section className="space-y-4 rounded-2xl border bg-card/80 p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="inline-flex rounded-lg border p-0.5" role="tablist">
                {(["fr", "en"] as const).map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="tab"
                    aria-selected={locale === l}
                    onClick={() => setLocale(l)}
                    className={cn("rounded-md px-3 py-1 text-sm font-medium", locale === l ? "bg-grad-gold text-[#1a1204]" : "text-muted-foreground hover:text-foreground")}
                  >
                    {l === "fr" ? "Français" : "English"}
                    {data.locales[l].edited && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-current align-middle" />}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground">{data.locales[locale].edited ? t("email.templates.edited") : t("email.templates.default")}</span>
            </div>
            <Field id="tpl-subject" label={t("email.templates.subject")}>
              <Input id="tpl-subject" value={text.subject} maxLength={200} onChange={(e) => setText({ subject: e.target.value })} />
            </Field>
            <Field id="tpl-body" label={t("email.templates.body")}>
              <Textarea id="tpl-body" ref={bodyRef} rows={14} value={text.body} onChange={(e) => setText({ body: e.target.value })} className="font-mono text-[13px] leading-relaxed" />
            </Field>
            {data.hasButton && (
              <Field id="tpl-action" label={t("email.templates.button")}>
                <Input id="tpl-action" value={text.action} maxLength={80} onChange={(e) => setText({ action: e.target.value })} />
              </Field>
            )}
            <div>
              <p className="mb-2 text-xs text-muted-foreground">{t("email.templates.variablesHint")}</p>
              <div className="flex flex-wrap gap-1.5">
                {data.variables.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => insertVariable(v)}
                    title={t(`email.variables.${v}`)}
                    className="rounded-md border bg-background/50 px-2 py-1 font-mono text-[11px] text-primary transition-colors hover:border-[color:var(--gold)]/50"
                  >
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 border-t pt-4">
              <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending || !text.subject.trim() || !text.body.trim()} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
                {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
              </Button>
              <Button variant="outline" onClick={() => sendTest.mutate()} disabled={sendTest.isPending}>
                {sendTest.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("email.templates.sendTest")}
              </Button>
              {data.locales[locale].edited && (
                <Button variant="ghost" className="text-muted-foreground" onClick={() => window.confirm(t("email.templates.restoreConfirm")) && reset.mutate()}>
                  <RotateCcw className="size-4" /> {t("email.templates.restore")}
                </Button>
              )}
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border bg-card/80">
            <div className="border-b px-5 py-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("email.templates.preview")}</p>
              <p className="mt-0.5 truncate text-sm font-medium">{preview?.subject ?? "…"}</p>
            </div>
            {/* Sandboxed: the preview cannot run scripts or reach the portal */}
            <iframe title={t("email.templates.preview")} sandbox="" srcDoc={preview?.html ?? ""} className="h-[620px] w-full bg-[#f4f4f1]" />
          </section>
        </div>
      )}
    </div>
  );
}
