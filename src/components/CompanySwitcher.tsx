import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, Check, ChevronDown, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";
import type { Me } from "@/lib/types";

type Company = NonNullable<Me["clientCompanies"]>[number];
type CompaniesView = { active: string | null; companies: Company[] };

/**
 * The company a client user works as. With one company it is just the name; with several (a grant on another
 * company of the chain) it opens a menu. Switching changes the session, so the page reloads from the start.
 */
export function CompanySwitcher({ name }: { name: string | undefined }) {
  const { t } = useTranslation();
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const { data } = useQuery({
    queryKey: ["portal", "companies"],
    queryFn: () => api.get<CompaniesView>("/portal/companies"),
    enabled: me.clientCompanies === undefined && !me.viewAs,
  });
  const companies = me.clientCompanies ?? data?.companies ?? [];
  if (me.viewAs || companies.length < 2) return <span className="truncate text-sm font-medium">{name}</span>;

  const home = companies.find((c) => c.home) ?? companies[0];
  const activeId = me.activeClientId ?? home.id;
  const active = companies.find((c) => c.id === activeId) ?? home;

  async function choose(id: string) {
    if (busy || id === activeId) return;
    setBusy(true);
    try {
      await api.put("/portal/active-company", { clientId: id === home.id ? null : id });
      toast.success(t("selfManaged.client.company.switched"));
      window.location.assign("/");
    } catch {
      toast.error(t("selfManaged.client.company.error"));
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          aria-label={`${t("selfManaged.client.company.choose")}: ${active.name}`}
          className="flex min-w-0 items-center gap-1.5 rounded-lg border border-transparent px-2 py-1 text-sm font-medium transition-colors hover:border-[color:var(--glass-border)] hover:bg-foreground/[0.04] data-[state=open]:border-[color:var(--gold)]/40 data-[state=open]:bg-foreground/[0.04]"
        >
          {busy ? <Loader2 className="size-4 shrink-0 animate-spin text-primary" /> : <Building2 className="size-4 shrink-0 text-primary" />}
          <span className="truncate">{active.name}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="glass-strong w-72">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("selfManaged.client.company.label")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={activeId} onValueChange={(v) => void choose(v)}>
          {companies.map((c) => {
            const sub = [c.home ? t("selfManaged.client.company.home") : c.parentName ? t("selfManaged.client.company.via", { name: c.parentName }) : null, c.roleName]
              .filter(Boolean)
              .join(" · ");
            return (
              <DropdownMenuRadioItem key={c.id} value={c.id} className="items-start py-2">
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-sm ${c.id === activeId ? "font-semibold" : ""}`}>{c.name}</span>
                  {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
                </span>
                {c.id === activeId && <Check className="ml-2 mt-0.5 size-4 shrink-0 text-primary" />}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
