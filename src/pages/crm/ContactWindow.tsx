import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Loader2, Mail, Settings2, ShieldCheck, SlidersHorizontal, UserRound, X } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccessTab, PreferencesTab, SecurityTab, UserStatusBadges } from "@/admin/UserPanels";
import { useAdminError, useClientRoles, useClientUsers, useRoleName } from "@/admin/hooks";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import type { AdminUser } from "@/lib/types";
import { cn, initials } from "@/lib/utils";
import { ticketErrorText } from "@/pages/tickets/shared";
import type { CrmContact, CrmDetail } from "./shared";

/**
 * One contact of a client, as a page of its own: their card, what they are
 * allowed (role and granular rights), how they get in (portal access, password,
 * MFA) and their preferences. The same person is a contact here and a user of
 * the portal; everything about them is in this one place.
 */
export function ContactWindow({ client, contactId, onClose, onChange }: { client: CrmDetail; contactId: string; onClose: () => void; onChange: () => void }) {
  const { t } = useTranslation();
  const can = useCan();
  const roleName = useRoleName();
  const manage = can("admin.clients");
  const [tab, setTab] = useState("card");
  const { data: contacts = [] } = useQuery({ queryKey: ["crm", "client", client.id, "contacts"], queryFn: () => api.get<CrmContact[]>(`/crm/clients/${client.id}/contacts`) });
  const contact = contacts.find((c) => c.id === contactId) ?? null;
  const { data: users = [] } = useClientUsers(manage ? client.id : null);
  const { data: roles = [] } = useClientRoles(manage ? client.id : null);
  const user = contact?.userId ? (users.find((u) => u.id === contact.userId) ?? null) : null;
  const role = roles.find((r) => r.id === user?.roleId);
  const name = contact ? `${contact.firstName} ${contact.lastName}`.trim() : "";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[calc(100dvh-3rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-5xl"
      >
        <header className="flex items-start gap-4 border-b px-6 py-5">
          <Avatar className="size-14 ring-1 ring-[color:var(--gold)]/40">
            <AvatarFallback className="bg-grad-gold text-lg font-bold text-[#1a1204]">{initials(name || "?")}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate font-display text-2xl">{name || "…"}</DialogTitle>
            <DialogDescription className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              {contact?.title && <span>{contact.title}</span>}
              {contact?.email && (
                <a href={`mailto:${contact.email}`} className="flex items-center gap-1 hover:text-foreground">
                  <Mail className="size-3.5" /> {contact.email}
                </a>
              )}
              <span>{client.name}</span>
            </DialogDescription>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {contact && !contact.active && <Badge variant="outline">{t("crm.contacts.inactive")}</Badge>}
              {role && <Badge variant="secondary">{roleName(role)}</Badge>}
              {user ? (
                <>
                  {!client.portalEnabled && <Badge variant="outline" className="text-muted-foreground">{t("crm.portal.ready")}</Badge>}
                  {client.portalEnabled && user.active && user.mustChangePassword && <Badge variant="outline" className="border-amber-500/40 text-amber-400">{t("crm.portal.pending")}</Badge>}
                  {user.lastLoginAt && <span className="text-xs text-muted-foreground">{t("crm.portal.lastLogin", { when: relativeTime(user.lastLoginAt) })}</span>}
                  <UserStatusBadges u={user} />
                </>
              ) : (
                <span className="text-xs text-muted-foreground">{t("crm.portal.none")}</span>
              )}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label={t("common.close")} className="rounded-xl border p-2 text-muted-foreground transition-colors hover:text-foreground">
            <X className="size-4" />
          </button>
        </header>

        {!contact ? (
          <div className="grid flex-1 place-items-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-6 mt-4 h-auto w-fit flex-wrap justify-start">
              <TabsTrigger value="card">
                <UserRound className="size-4" /> {t("crm.contactWindow.card")}
              </TabsTrigger>
              {manage && (
                <>
                  <TabsTrigger value="rights">
                    <ShieldCheck className="size-4" /> {t("crm.contactWindow.rights")}
                  </TabsTrigger>
                  <TabsTrigger value="access">
                    <KeyRound className="size-4" /> {t("crm.contactWindow.access")}
                  </TabsTrigger>
                  <TabsTrigger value="prefs">
                    <SlidersHorizontal className="size-4" /> {t("crm.contactWindow.prefs")}
                  </TabsTrigger>
                </>
              )}
            </TabsList>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 scrollbar-thin">
              <TabsContent value="card" className="mt-0">
                <CardTab client={client} contact={contact} onChange={onChange} />
              </TabsContent>
              {manage && (
                <>
                  <TabsContent value="rights" className="mt-0 max-w-3xl">
                    {user ? <AccessTab key={user.id} user={user} roles={roles} /> : <NoAccount client={client} contact={contact} onChange={onChange} />}
                  </TabsContent>
                  <TabsContent value="access" className="mt-0 max-w-2xl">
                    {user ? <AccessPanel client={client} user={user} onChange={onChange} /> : <NoAccount client={client} contact={contact} onChange={onChange} />}
                  </TabsContent>
                  <TabsContent value="prefs" className="mt-0">
                    {user ? <PreferencesTab key={user.id} user={user} /> : <NoAccount client={client} contact={contact} onChange={onChange} />}
                  </TabsContent>
                </>
              )}
            </div>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/** The contact's card: name, title, email, phones, and whether they are still a contact. */
function CardTab({ client, contact, onChange }: { client: CrmDetail; contact: CrmContact; onChange: () => void }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const editable = can("crm.edit");
  const init = () => ({ firstName: contact.firstName, lastName: contact.lastName, email: contact.email ?? "", phone: contact.phone ?? "", mobile: contact.mobile ?? "", title: contact.title ?? "" });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [contact.id, contact.firstName, contact.lastName, contact.email, contact.phone, contact.mobile, contact.title]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["crm", "client", client.id] });
    void qc.invalidateQueries({ queryKey: ["admin"] });
    onChange();
  };
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/crm/clients/${client.id}/contacts/${contact.id}`, patch),
    onSuccess: () => {
      toast.success(t("crm.contacts.saved"));
      refresh();
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const box = (k: keyof typeof f, label: string, type = "text", required = false) => (
    <Field label={label}>
      <Input type={type} required={required} disabled={!editable} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </Field>
  );
  return (
    <form
      className="max-w-3xl space-y-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate(f);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {box("firstName", t("crm.contacts.firstName"), "text", true)}
        {box("lastName", t("crm.contacts.lastName"), "text", true)}
        {box("title", t("crm.contacts.title"))}
        {box("email", t("crm.contacts.email"), "email")}
        {box("phone", t("crm.contacts.phone"), "tel")}
        {box("mobile", t("crm.contacts.mobile"), "tel")}
      </div>
      {editable && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
          <Button type="button" variant="outline" disabled={save.isPending} onClick={() => save.mutate({ active: !contact.active })}>
            {contact.active ? t("crm.contacts.deactivate") : t("crm.contacts.reactivate")}
          </Button>
          <Button type="submit" disabled={save.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
            {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("crm.info.save")}
          </Button>
        </div>
      )}
    </form>
  );
}

/** A contact with no portal account (no email yet, or turned away): make it. */
function NoAccount({ client, contact, onChange }: { client: CrmDetail; contact: CrmContact; onChange: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const make = useMutation({
    mutationFn: () => api.put(`/crm/clients/${client.id}/contacts/${contact.id}/portal`, { enabled: true, role: "client-user" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["crm", "client", client.id] });
      void qc.invalidateQueries({ queryKey: ["admin"] });
      onChange();
      toast.success(t("crm.contactWindow.accountMade"));
    },
    onError: (e) => toast.error(e instanceof ApiError && ["portal_no_email", "email_taken", "portal_inactive"].includes(e.code) ? t(`crm.portal.errors.${e.code}`) : t("common.error")),
  });
  return (
    <div className="max-w-xl rounded-2xl border border-dashed p-8 text-center">
      <p className="text-sm text-muted-foreground">{contact.email ? t("crm.contactWindow.noAccount") : t("crm.contactWindow.noEmail")}</p>
      {contact.email && (
        <Button className="mt-4" disabled={make.isPending || !contact.active} onClick={() => make.mutate()}>
          {make.isPending && <Loader2 className="size-4 animate-spin" />} {t("crm.contactWindow.makeAccount")}
        </Button>
      )}
    </div>
  );
}

/** How this person gets in: portal access on or off for them, and the password and MFA tools. */
function AccessPanel({ client, user, onChange }: { client: CrmDetail; user: AdminUser; onChange: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errText = useAdminError();
  const set = useMutation({
    mutationFn: (active: boolean) => api.patch(`/admin/users/${user.id}`, { active }),
    onSuccess: (_r, active) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: ["crm", "client", client.id] });
      onChange();
      toast.success(active ? t("crm.contactWindow.accessOn") : t("crm.portal.removed"));
    },
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <div className="space-y-5">
      <div className={cn("rounded-xl border p-4", client.portalEnabled ? "bg-background/30" : "border-amber-500/40 bg-amber-500/[0.06]")}>
        <div className="flex items-start gap-3">
          <Settings2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("crm.contactWindow.personAccess")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{client.portalEnabled ? t("crm.contactWindow.personAccessHint") : t("crm.contactWindow.portalClosed")}</p>
          </div>
          {set.isPending ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <Switch checked={user.active} onCheckedChange={(v) => set.mutate(v)} aria-label={t("crm.contactWindow.personAccess")} />}
        </div>
      </div>
      <SecurityTab user={user} />
    </div>
  );
}
