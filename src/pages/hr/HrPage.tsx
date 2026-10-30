import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, HeartHandshake, Loader2, Search } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { HrFile } from "@/components/HrFile";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn, initials } from "@/lib/utils";

type Person = {
  id: string;
  name: string;
  email: string;
  active: boolean;
  hourlyWageCents: number | null;
  bankCents: number;
  vacationCents: number;
  sickHours: number;
  negative: string[];
};

/**
 * Gestion › RH (hr.manage): every employee with their wage and their three accounts (hours bank and vacation in dollars, sick days
 * in hours). A click opens their file — the RH tab of their profile — in a window.
 */
export function HrPage() {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ["hr", "people"], queryFn: () => api.get<Person[]>("/hr/people") });
  const loc = i18n.language === "en" ? "en-CA" : "fr-CA";
  const money = (cents: number) => new Intl.NumberFormat(loc, { style: "currency", currency: "CAD" }).format(cents / 100);
  const h = (n: number) => n.toLocaleString(loc, { maximumFractionDigits: 2 });
  const opened = params.get("user");
  const person = data?.find((p) => p.id === opened);
  const list = (data ?? []).filter((p) => (showInactive || p.active) && (!q.trim() || `${p.name} ${p.email}`.toLowerCase().includes(q.trim().toLowerCase())));
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete("user");
    setParams(next, { replace: true });
  };
  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <HeartHandshake className="size-6 text-primary" /> {t("hr.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("hr.subtitle")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-72 max-w-full">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("hr.search")} className="pl-9" />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> {t("hr.showInactive")}
        </label>
      </div>
      {isLoading && <Loader2 className="mx-auto my-10 size-6 animate-spin text-muted-foreground" />}
      {data && (
        <div className="glass overflow-hidden rounded-2xl border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">{t("hr.employee")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("hr.wage")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("hr.account.bank")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("hr.account.vacation")}</th>
                <th className="px-4 py-2 text-right font-medium">{t("hr.account.sick")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {list.map((p) => (
                <tr key={p.id} className="cursor-pointer transition hover:bg-accent/40" onClick={() => setParams({ user: p.id }, { replace: true })}>
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-3">
                      <Avatar className="size-8">
                        <AvatarFallback className="bg-grad-gold text-xs font-bold text-[#1a1204]">{initials(p.name)}</AvatarFallback>
                      </Avatar>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 font-medium">
                          {p.name}
                          {!p.active && <Badge variant="outline" className="text-muted-foreground">{t("common.inactive")}</Badge>}
                          {p.negative.length > 0 && <AlertTriangle className="size-3.5 text-destructive" aria-label={t("hr.negativeShort")} />}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">{p.email}</span>
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{p.hourlyWageCents != null ? `${money(p.hourlyWageCents)}/h` : <span className="text-muted-foreground">—</span>}</td>
                  <td className={cn("px-3 py-2 text-right font-mono", p.bankCents < 0 && "text-destructive")}>{money(p.bankCents)}</td>
                  <td className={cn("px-3 py-2 text-right font-mono", p.vacationCents < 0 && "text-destructive")}>{money(p.vacationCents)}</td>
                  <td className={cn("px-4 py-2 text-right font-mono", p.sickHours < 0 && "text-destructive")}>{h(p.sickHours)} h</td>
                </tr>
              ))}
              {!list.length && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {t("hr.none")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <Dialog open={Boolean(opened)} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              <Avatar className="size-10">
                <AvatarFallback className="bg-grad-gold font-bold text-[#1a1204]">{initials(person?.name ?? "")}</AvatarFallback>
              </Avatar>
              <span className="min-w-0">
                <span className="block truncate font-display text-xl">{person?.name ?? ""}</span>
                <span className="block truncate text-xs font-normal text-muted-foreground">{person?.email}</span>
              </span>
            </DialogTitle>
            <DialogDescription>{t("hr.tab")}</DialogDescription>
          </DialogHeader>
          {opened && <HrFile key={opened} userId={opened} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
