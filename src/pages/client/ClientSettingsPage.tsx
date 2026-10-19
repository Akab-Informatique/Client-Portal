import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Building2, Globe, Mail, MapPin, Phone, Settings2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PageHeader, Pane, Segmented } from "./ui";

type Company = { name: string; email: string | null; phone: string | null; address: string | null; city: string | null; province: string | null; postalCode: string | null; website: string | null };
type PortalUser = { id: string; name: string; email: string; title: string | null; phone: string | null; active: boolean; lastLoginAt: string | null; role: { fr: string; en: string } | null };

/** Client portal › Admin settings (name menu): the company and its users, read only for now. */
export function ClientSettingsPage() {
  const { t } = useTranslation();
  const can = useCan();
  const tabs = [
    can("clientAdmin.company") && { key: "company" as const, icon: Building2, label: t("client.settings.company") },
    can("clientAdmin.users") && { key: "users" as const, icon: Users, label: t("client.settings.users") },
  ].filter((x): x is { key: "company" | "users"; icon: typeof Users; label: string } => Boolean(x));
  const [tab, setTab] = useState<"company" | "users">(tabs[0]?.key ?? "company");
  if (!tabs.length) return <Navigate to="/" replace />;
  const current = tabs.some((x) => x.key === tab) ? tab : tabs[0].key;

  return (
    <div className="space-y-6">
      <PageHeader icon={Settings2} title={t("client.settings.title")} subtitle={t("client.settings.subtitle")} />
      {tabs.length > 1 && (
        <Segmented
          id="client-settings"
          className="pane sm:w-fit"
          value={current}
          onChange={setTab}
          options={tabs.map((x) => ({
            value: x.key,
            label: (
              <>
                <x.icon className="size-4" /> {x.label}
              </>
            ),
          }))}
        />
      )}
      {current === "company" ? <CompanyCard /> : <UserList />}
    </div>
  );
}

function CompanyCard() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({ queryKey: ["portal", "company"], queryFn: () => api.get<Company>("/portal/company") });
  if (isLoading || !data) return <div className="pane h-48 animate-pulse rounded-2xl" />;
  const place = [data.address, [data.city, data.province].filter(Boolean).join(", "), data.postalCode].filter(Boolean).join(" · ");
  const rows = [
    { icon: Mail, label: t("common.email"), value: data.email },
    { icon: Phone, label: t("common.phone"), value: data.phone },
    { icon: MapPin, label: t("client.settings.address"), value: place || null },
    { icon: Globe, label: t("client.settings.website"), value: data.website },
  ];
  return (
    <Pane edge className="p-6">
      <h2 className="flex items-center gap-3 text-xl font-semibold">
        <span className="flex size-10 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204]">
          <Building2 className="size-5" />
        </span>
        {data.name}
      </h2>
      <dl className="mt-6 grid gap-3 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start gap-3 rounded-xl border border-[color:var(--glass-border)] bg-foreground/[0.02] p-3.5">
            <r.icon className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{r.label}</dt>
              <dd className="break-words text-sm">{r.value || "—"}</dd>
            </div>
          </div>
        ))}
      </dl>
      <p className="mt-5 text-xs text-muted-foreground">{t("client.settings.companyHint")}</p>
    </Pane>
  );
}

function UserList() {
  const { t, i18n } = useTranslation();
  const { data = [], isLoading } = useQuery({ queryKey: ["portal", "users"], queryFn: () => api.get<PortalUser[]>("/portal/users") });
  if (isLoading) return <div className="pane h-48 animate-pulse rounded-2xl" />;
  return (
    <Pane className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-[color:var(--glass-border)] px-5 py-3.5">
        <h2 className="flex items-center gap-2 font-semibold">
          <Users className="size-5 text-primary" /> {t("client.settings.users")}
        </h2>
        <span className="text-xs text-muted-foreground">{t("client.settings.userCount", { count: data.length })}</span>
      </div>
      <ul className="divide-y divide-[color:var(--glass-border)]">
        {data.map((u) => (
          <li key={u.id} className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 transition-colors hover:bg-foreground/[0.025]", !u.active && "opacity-60")}>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/10 text-xs font-bold text-primary">
              {u.name
                .split(" ")
                .map((w) => w[0])
                .slice(0, 2)
                .join("")}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{u.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {u.email}
                {u.title && ` · ${u.title}`}
                {u.phone && ` · ${u.phone}`}
              </p>
            </div>
            {u.role && (
              <Badge variant="outline" className="rounded-full border-[color:var(--gold)]/30 bg-[color:var(--gold)]/[0.06]">
                {i18n.language === "en" ? u.role.en : u.role.fr}
              </Badge>
            )}
            {!u.active && <Badge variant="secondary">{t("common.inactive")}</Badge>}
            <span className="w-36 text-right text-xs text-muted-foreground">
              {u.lastLoginAt ? t("client.settings.lastLogin", { when: relativeTime(u.lastLoginAt) }) : t("client.settings.neverLoggedIn")}
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-[color:var(--glass-border)] px-5 py-3 text-xs text-muted-foreground">{t("client.settings.usersHint")}</p>
    </Pane>
  );
}
