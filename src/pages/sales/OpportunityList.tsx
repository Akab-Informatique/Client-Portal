import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { shortDate } from "@/pages/tickets/shared";
import { SALES_KINDS, SALES_SOURCES, SALES_STAGES, isOpenStage } from "@shared/sales";
import { STAGE_TONE, shortMoney, type Opportunity } from "./shared";

/** The opportunities as a table, filtered by stage, source, type and the page's period. */
export function OpportunityList({ list, from, to, onOpen }: { list: Opportunity[]; from: string; to: string; onOpen: (o: Opportunity) => void }) {
  const { t, i18n } = useTranslation();
  const [stage, setStage] = useState("all");
  const [source, setSource] = useState("all");
  const [kind, setKind] = useState("all");
  const [inPeriod, setInPeriod] = useState(true);
  const [q, setQ] = useState("");
  const words = q.trim().toLowerCase();
  const inRange = (d: string | null) => !!d && d >= from && d <= to;
  const rows = list
    .filter((o) => stage === "all" || (stage === "open" ? isOpenStage(o.stage) : o.stage === stage))
    .filter((o) => source === "all" || o.source === source)
    .filter((o) => kind === "all" || o.kind === kind)
    // in the period: opened in it, or won / lost in it
    .filter((o) => !inPeriod || inRange(o.openedOn) || inRange(o.closedOn))
    .filter((o) => !words || `${o.companyName} ${o.contactName ?? ""} ${o.contactEmail ?? ""} ${o.ownerName ?? ""}`.toLowerCase().includes(words));
  const mrr = rows.reduce((n, o) => n + o.monthlyCents, 0);
  const once = rows.reduce((n, o) => n + (o.kind === "one_time" ? (o.oneTimeCents ?? 0) : 0), 0);

  const pick = (value: string, onChange: (v: string) => void, label: string, items: [string, string][]) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-auto min-w-40" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map(([v, l]) => (
          <SelectItem key={v} value={v}>
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <section className="glass space-y-4 rounded-2xl border p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("sales.list.search")} aria-label={t("sales.list.search")} className="pl-9" />
        </div>
        {pick(stage, setStage, t("sales.f.stage"), [["all", t("sales.list.allStages")], ["open", t("sales.list.openStages")], ...SALES_STAGES.map((s) => [s, t(`sales.stage.${s}`)] as [string, string])])}
        {pick(source, setSource, t("sales.f.source"), [["all", t("sales.list.allSources")], ...SALES_SOURCES.map((s) => [s, t(`sales.source.${s}`)] as [string, string])])}
        {pick(kind, setKind, t("sales.f.kind"), [["all", t("sales.list.allKinds")], ...SALES_KINDS.map((k) => [k, t(`sales.kind.${k}`)] as [string, string])])}
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" className="size-4 accent-[color:var(--gold)]" checked={inPeriod} onChange={(e) => setInPeriod(e.target.checked)} />
          {t("sales.list.inPeriod")}
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 pr-3 font-medium">{t("sales.f.company")}</th>
              <th className="pb-2 pr-3 font-medium">{t("sales.f.stage")}</th>
              <th className="pb-2 pr-3 font-medium">{t("sales.f.source")}</th>
              <th className="pb-2 pr-3 text-right font-medium">{t("sales.list.value")}</th>
              <th className="pb-2 pr-3 text-right font-medium">%</th>
              <th className="pb-2 pr-3 font-medium">{t("sales.f.nextFollowUp")}</th>
              <th className="pb-2 pr-3 font-medium">{t("sales.f.openedOn")}</th>
              <th className="pb-2 font-medium">{t("sales.f.owner")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} onClick={() => onOpen(o)} className="cursor-pointer border-b border-border/50 hover:bg-accent/40">
                <td className="py-2.5 pr-3">
                  <p className="font-medium">{o.companyName}</p>
                  {o.contactName && <p className="text-xs text-muted-foreground">{o.contactName}</p>}
                </td>
                <td className="py-2.5 pr-3">
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    <span className={cn("size-2 rounded-full", STAGE_TONE[o.stage])} />
                    {t(`sales.stage.${o.stage}`)}
                  </span>
                  {o.stage === "lost" && o.lostReason && <p className="text-xs text-muted-foreground">{t(`sales.lost.${o.lostReason}`)}</p>}
                </td>
                <td className="py-2.5 pr-3 text-muted-foreground">{t(`sales.source.${o.source}`)}</td>
                <td className="whitespace-nowrap py-2.5 pr-3 text-right tabular-nums">
                  {o.kind === "recurring" ? (
                    <>
                      {shortMoney(o.monthlyCents, i18n.language)}
                      <span className="text-muted-foreground">{t("sales.perMonth")}</span>
                      {o.users != null && <p className="text-xs text-muted-foreground">{t("sales.usersCount", { count: o.users })}</p>}
                    </>
                  ) : (
                    <>
                      {shortMoney(o.oneTimeCents ?? 0, i18n.language)} <span className="text-muted-foreground">{t("sales.oneTimeShort")}</span>
                    </>
                  )}
                </td>
                <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">{o.probability}</td>
                <td className={cn("whitespace-nowrap py-2.5 pr-3", o.overdue ? "font-semibold text-red-400" : "text-muted-foreground")}>{o.nextFollowUp && isOpenStage(o.stage) ? shortDate(o.nextFollowUp) : "-"}</td>
                <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground">{shortDate(o.openedOn)}</td>
                <td className="py-2.5 text-muted-foreground">{o.ownerName ?? "-"}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="font-semibold">
                <td className="pt-3" colSpan={3}>
                  {t("sales.list.total", { count: rows.length })}
                </td>
                <td className="whitespace-nowrap pt-3 text-right tabular-nums">
                  {shortMoney(mrr, i18n.language)}
                  {t("sales.perMonth")}
                  {once > 0 && <p className="text-xs font-normal text-muted-foreground">+ {shortMoney(once, i18n.language)} {t("sales.oneTimeShort")}</p>}
                </td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          )}
        </table>
        {!rows.length && <p className="py-10 text-center text-sm text-muted-foreground">{t("sales.list.empty")}</p>}
      </div>
    </section>
  );
}
