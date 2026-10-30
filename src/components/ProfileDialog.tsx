import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  ExternalLink,
  Inbox,
  KeyRound,
  LogIn,
  LogOut,
  Loader2,
  Mail,
  PenLine,
  HeartHandshake,
  Plus,
  Smartphone,
  Timer,
  Trash2,
  UserRound,
  BellRing,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { LinkMailboxDialog } from "@/pages/outlook/dialogs";
import { TimeReportCard } from "@/pages/time/TimeReport";
import { HrFile } from "@/components/HrFile";
import { RichEditor, type RichEditorHandle } from "@/pages/outlook/RichEditor";
import { PhoneSignInCard } from "@/components/PhoneSignInCard";
import { KEY, outlookErrorText, statusKey, type MailAccount, type OutlookStatus } from "@/pages/outlook/shared";

export function ProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const staff = me.kind === "staff";
  const [form, setForm] = useState({ name: me.name, title: me.title ?? "", phone: me.phone ?? "", mobile: me.mobile ?? "", notifyEmail: me.notifyEmail });
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);

  useEffect(() => {
    if (open) setForm({ name: me.name, title: me.title ?? "", phone: me.phone ?? "", mobile: me.mobile ?? "", notifyEmail: me.notifyEmail });
  }, [open, me]);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // technicians: the cell phone only; clients: their phone
      const { phone, mobile, ...rest } = form;
      await api.patch("/me", staff ? { ...rest, mobile } : { ...rest, phone });
      await qc.invalidateQueries({ queryKey: ["auth"] });
      toast.success(t("common.saved"));
    } catch (err) {
      toast.error(err instanceof ApiError && err.fields?.some((f) => f.path === "mobile") ? t("profile.mobileInvalid") : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (pw.next !== pw.confirm) return toast.error(t("password.mismatch"));
    if (pw.next.length < 12) return toast.error(t("password.short"));
    setPwBusy(true);
    try {
      await api.post("/auth/password", { current: pw.current, next: pw.next });
      setPw({ current: "", next: "", confirm: "" });
      toast.success(t("password.changed"));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      toast.error(code === "wrong_password" ? t("password.wrong") : code === "password_same" ? t("password.same") : t("common.error"));
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-h-[92dvh] overflow-y-auto", staff ? "sm:max-w-[min(1100px,94vw)]" : "sm:max-w-2xl")}>
        <DialogHeader>
          <DialogTitle>{t("topbar.profile")}</DialogTitle>
          <DialogDescription>{me.email}</DialogDescription>
        </DialogHeader>
        <div className={cn("grid gap-4", staff && "lg:grid-cols-2")}>
          <div className="space-y-4">
            <Card icon={UserRound} title={t("profile.identity")}>
              <form onSubmit={saveProfile} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="p-name">{t("common.name")}</Label>
                    <Input id="p-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="p-title">{t("common.title")}</Label>
                    <Input id="p-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                  </div>
                </div>
                {staff ? (
                  <div className="space-y-2">
                    <Label htmlFor="p-mobile" className="flex items-center gap-2">
                      <Smartphone className="size-3.5 text-primary" /> {t("profile.mobile")}
                    </Label>
                    <Input
                      id="p-mobile"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      value={form.mobile}
                      onChange={(e) => setForm({ ...form, mobile: e.target.value })}
                      placeholder="+1 450 555-0123"
                    />
                    <p className="text-[11px] text-muted-foreground">{t("profile.mobileHint")}</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="p-phone">{t("common.phone")}</Label>
                    <Input id="p-phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                  </div>
                )}
                {!staff && (
                  <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm">
                    {t("admin.users.notify")}
                    <Switch checked={form.notifyEmail} onCheckedChange={(v) => setForm({ ...form, notifyEmail: v })} />
                  </label>
                )}
                <div className="flex justify-end">
                  <Button type="submit" disabled={busy}>
                    {busy && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
                  </Button>
                </div>
              </form>
            </Card>
            <Card icon={KeyRound} title={t("password.next")}>
              <form onSubmit={changePassword} className="space-y-3">
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder={t("password.current")}
                  required
                  value={pw.current}
                  onChange={(e) => setPw({ ...pw, current: e.target.value })}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    placeholder={t("password.next")}
                    required
                    value={pw.next}
                    onChange={(e) => setPw({ ...pw, next: e.target.value })}
                  />
                  <Input
                    type="password"
                    autoComplete="new-password"
                    placeholder={t("password.confirm")}
                    required
                    value={pw.confirm}
                    onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
                  />
                </div>
                <p className="text-xs text-muted-foreground">{t("password.rule")}</p>
                <div className="flex justify-end">
                  <Button type="submit" variant="outline" disabled={pwBusy}>
                    {pwBusy && <Loader2 className="size-4 animate-spin" />} {t("password.submit")}
                  </Button>
                </div>
              </form>
            </Card>
            <PhoneSignInCard />
          </div>
          {staff && (
            <div className="space-y-4">
              <HoursCard />
              <HrCard />
              <NotifyCard />
              <Microsoft365Card onNavigate={() => onOpenChange(false)} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Card({ icon: Icon, title, children, className }: { icon: typeof Mail; title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl border bg-background/40 p-4", className)}>
      <h3 className="mb-3 flex items-center gap-2 font-display text-sm font-semibold">
        <Icon className="size-4 text-primary" /> {title}
      </h3>
      {children}
    </section>
  );
}

/** The channels ticked by default when I notify a technician from a ticket (the bell is always on). */
function NotifyCard() {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const cur = me.preferences.notify ?? { email: true, sms: false, teams: false };
  const save = useMutation({
    mutationFn: (notify: typeof cur) => api.put("/me/preferences", { notify }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["auth"] });
      toast.success(t("common.saved"));
    },
    onError: () => toast.error(t("common.error")),
  });
  if (!can("tickets.edit")) return null;
  return (
    <Card icon={BellRing} title={t("profile.notify.title")} className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("profile.notify.hint")}</p>
      {(["email", "sms", "teams"] as const).map((k) => (
        <label key={k} className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm">
          <span className="font-medium">{t(`tickets.notifyTech.channel.${k}`)}</span>
          <Switch checked={cur[k]} disabled={save.isPending} onCheckedChange={(v) => save.mutate({ ...cur, [k]: v })} aria-label={t(`tickets.notifyTech.channel.${k}`)} />
        </label>
      ))}
    </Card>
  );
}

/** My hours: my time report (the hours I am paid; managers: anyone's). */
function HoursCard() {
  const { t } = useTranslation();
  const can = useCan();
  if (!can("timesheets.use") && !can("timesheets.manage")) return null;
  return (
    <Card icon={Timer} title={t("profile.hours.title")} className="space-y-3">
      <TimeReportCard />
    </Card>
  );
}

/** My HR file (hr.own, or hr.manage): my hourly wage, hours bank, vacation and sick days — only mine, read only. */
function HrCard() {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  if (!can("hr.own") && !can("hr.manage")) return null;
  return (
    <Card icon={HeartHandshake} title={t("hr.tab")} className="space-y-3">
      <HrFile userId={me.id} />
    </Card>
  );
}

/** Everything Microsoft 365 for this technician: the Outlook calendar, and the Outlook module with its mailboxes. */
function Microsoft365Card({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const on = me.preferences.outlook;
  const toggle = useMutation({
    mutationFn: (outlook: boolean) => api.put("/me/preferences", { outlook }),
    onSuccess: (_r, outlook) => {
      void qc.invalidateQueries({ queryKey: ["auth"] });
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(outlook ? t("profile.outlookOn") : t("profile.outlookOff"));
    },
    onError: () => toast.error(t("common.error")),
  });
  return (
    <Card icon={Mail} title={t("profile.o365Title")} className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("profile.o365Intro")}</p>

      {/* The technician's own Microsoft account: they link their things themselves */}
      <MicrosoftAccount />

      {/* Calendar: allowed by an admin */}
      <div className="rounded-xl border p-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <CalendarDays className="size-4 text-primary" /> {t("profile.calendar")}
          <span
            className={cn(
              "ml-auto rounded-full border px-2 py-px text-[10px] font-medium",
              me.o365?.active ? "border-emerald-500/40 text-emerald-300" : me.o365 ? "border-orange-500/40 text-orange-300" : "text-muted-foreground",
            )}
          >
            {me.o365?.active ? t("profile.stateOn") : me.o365 ? t("profile.statePending") : t("profile.stateOff")}
          </span>
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {me.o365 ? (me.o365.active ? t("profile.o365On", { mailbox: me.o365.mailbox }) : t("profile.o365Pending")) : t("profile.o365Off")}
        </p>
      </div>

      {/* Outlook module: turned on by the technician, with their mailboxes */}
      {can("outlook.view") && (
        <div className={cn("rounded-xl border transition-colors", on && "border-[color:var(--gold)]/40")}>
          <label className="flex cursor-pointer items-center gap-2 p-3 text-sm font-medium">
            <Inbox className="size-4 text-primary" />
            <span className="flex-1">
              {t("profile.outlookModule")}
              <span className="block text-xs font-normal text-muted-foreground">{t("profile.outlookHint")}</span>
            </span>
            {toggle.isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            <Switch checked={on} disabled={toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} aria-label={t("profile.outlookModule")} />
            <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", on && "rotate-180")} />
          </label>
          {on && <Mailboxes onNavigate={onNavigate} />}
          {on && <SignatureEditor />}
        </div>
      )}
    </Card>
  );
}

/** The email signature, added at the bottom of the emails written in the Outlook module. */
function SignatureEditor() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const editor = useRef<RichEditorHandle>(null);
  const status = useQuery({ queryKey: statusKey, queryFn: () => api.get<OutlookStatus>("/outlook/status") });
  const save = useMutation({
    mutationFn: () => api.put<{ html: string }>("/outlook/signature", { html: editor.current?.html() ?? "" }),
    onSuccess: () => {
      toast.success(t("profile.signatureSaved"));
      void qc.invalidateQueries({ queryKey: statusKey });
    },
    onError: () => toast.error(t("common.error")),
  });
  if (!status.data) return null;
  return (
    <div className="space-y-2 border-t p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <PenLine className="size-4 text-primary" /> {t("profile.signature")}
      </p>
      <p className="text-xs text-muted-foreground">{t("profile.signatureHint")}</p>
      <RichEditor ref={editor} initialHtml={status.data.signature ?? ""} allowImages label={t("profile.signature")} minHeight="7rem" className="max-h-72" />
      <div className="flex justify-end">
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

type MsStatus = { available: boolean; connection: { email: string; displayName: string | null; connectedAt: string; needsReconnect: boolean } | null };
export const MS_KEY = ["microsoft"] as const;

/** Sign in with Microsoft (AKAB account): Microsoft's own page, then back here. */
function useMicrosoftSignIn() {
  const { t } = useTranslation();
  return useMutation({
    mutationFn: () => api.post<{ url: string }>("/microsoft/connect", {}),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e) => toast.error(e instanceof ApiError && e.code.startsWith("microsoft_") ? t(`profile.ms.${e.code.slice(10)}`) : t("common.error")),
  });
}

function MicrosoftAccount() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data } = useQuery({ queryKey: MS_KEY, queryFn: () => api.get<MsStatus>("/microsoft") });
  const signIn = useMicrosoftSignIn();
  const signOut = useMutation({
    mutationFn: () => api.del("/microsoft"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MS_KEY });
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t("profile.ms.signedOut"));
    },
    onError: () => toast.error(t("common.error")),
  });
  if (!data) return <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />;
  const c = data.connection;
  return (
    <div className={cn("rounded-xl border p-3", c && !c.needsReconnect && "border-emerald-500/30")}>
      <p className="flex items-center gap-2 text-sm font-medium">
        <UserRound className="size-4 text-primary" /> {t("profile.ms.account")}
      </p>
      {!data.available ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{t("profile.ms.notAvailable")}</p>
      ) : c ? (
        <div className="mt-2 space-y-2">
          <p className="text-xs">
            <span className="block font-medium">{c.displayName ?? c.email}</span>
            <span className="text-muted-foreground">{c.email}</span>
          </p>
          {c.needsReconnect && (
            <p className="flex items-start gap-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 p-2 text-xs text-orange-200">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {t("profile.ms.reconnect")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {c.needsReconnect && (
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5 bg-grad-gold font-semibold text-[#1a1204]"
                disabled={signIn.isPending}
                onClick={() => signIn.mutate()}
              >
                <LogIn className="size-3.5" /> {t("profile.ms.signInAgain")}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 text-muted-foreground"
              disabled={signOut.isPending}
              onClick={() => void confirm({ title: t("profile.ms.signOutConfirm"), destructive: true }).then((ok) => ok && signOut.mutate())}
            >
              <LogOut className="size-3.5" /> {t("profile.ms.signOut")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">{t("profile.ms.why")}</p>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5 bg-grad-gold font-semibold text-[#1a1204]"
            disabled={signIn.isPending}
            onClick={() => signIn.mutate()}
          >
            {signIn.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />} {t("profile.ms.signIn")}
          </Button>
        </div>
      )}
    </div>
  );
}

function Mailboxes({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [linkOpen, setLinkOpen] = useState(false);
  const status = useQuery({ queryKey: statusKey, queryFn: () => api.get<OutlookStatus>("/outlook/status") });
  const unlink = useMutation({
    mutationFn: (a: MailAccount) => api.del(`/outlook/accounts/${a.id}`),
    onSuccess: (_r, a) => {
      toast.success(t("outlook.unlinked"));
      void qc.invalidateQueries({ queryKey: statusKey });
      qc.removeQueries({ queryKey: [...KEY, "folders", a.id] });
    },
    onError: (e) => toast.error(outlookErrorText(t, e)),
  });
  const s = status.data;
  return (
    <div className="space-y-3 border-t p-3">
      {status.isLoading && <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />}
      {s && !s.ready && (
        <p className="rounded-lg border border-orange-500/40 bg-orange-500/10 p-2.5 text-xs text-orange-200">
          <span className="block font-medium">{t("outlook.notReady")}</span>
          {t("outlook.notReadyText")}
        </p>
      )}
      {s?.ready && (
        <>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("profile.mailboxes")}</p>
          {!s.signedIn && s.accounts.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("profile.ms.signInForMail")}</p>
          ) : s.accounts.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("outlook.noAccountsText")}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {s.accounts.map((a) => (
                <li key={a.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <Mail className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{a.displayName || a.address}</span>
                    {a.displayName && <span className="block truncate text-xs text-muted-foreground">{a.address}</span>}
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    title={t("outlook.unlink")}
                    disabled={unlink.isPending}
                    onClick={() =>
                      void confirm({ title: t("outlook.unlinkConfirm", { address: a.address }), destructive: true }).then((ok) => ok && unlink.mutate(a))
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {(s.canLinkAny || s.signedIn) && (
              <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setLinkOpen(true)}>
                <Plus className="size-3.5" /> {t("outlook.linkMailbox")}
              </Button>
            )}
            {s.accounts.length > 0 && (
              <Button asChild size="sm" variant="ghost" className="h-8 gap-1.5">
                <Link to="/outlook" onClick={onNavigate}>
                  <ExternalLink className="size-3.5" /> {t("profile.openOutlook")}
                </Link>
              </Button>
            )}
          </div>
          <LinkMailboxDialog open={linkOpen} onOpenChange={setLinkOpen} status={s} onLinked={() => undefined} />
        </>
      )}
    </div>
  );
}
