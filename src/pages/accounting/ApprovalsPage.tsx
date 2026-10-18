import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { ClipboardCheck, Clock, FileText, Hammer, Package, Wallet, type LucideIcon } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TABS: { key: string; icon: LucideIcon }[] = [
  { key: "labour", icon: Hammer },
  { key: "charges", icon: Package },
  { key: "contracts", icon: FileText },
  { key: "timesheets", icon: Clock },
  { key: "expenses", icon: Wallet },
];

/**
 * Accounting › Approve and post: labour, charges and contract billing become
 * invoice lines once approved; technicians' timesheets and expenses are
 * approved here too. The tabs are in place; each fills up as its data comes
 * into the portal's own database.
 */
export function ApprovalsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((x) => x.key === params.get("tab")) ? params.get("tab")! : "labour";
  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ClipboardCheck className="size-6 text-primary" /> {t("approvals.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("approvals.subtitle")}</p>
      </div>
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList className="h-auto flex-wrap justify-start">
          {TABS.map((x, i) => (
            <TabsTrigger key={x.key} value={x.key} className={i === 3 ? "sm:ml-3" : undefined}>
              <x.icon className="size-4" /> {t(`approvals.tabs.${x.key}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((x) => (
          <TabsContent key={x.key} value={x.key} className="mt-4">
            <div className="glass flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-14 text-center">
              <span className="grid size-12 place-items-center rounded-2xl border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/10">
                <x.icon className="size-6 text-primary" />
              </span>
              <p className="font-semibold">{t(`approvals.empty.${x.key}.title`)}</p>
              <p className="max-w-lg text-sm text-muted-foreground">{t(`approvals.empty.${x.key}.text`)}</p>
              <span className="rounded-full border border-dashed px-2.5 py-0.5 text-[11px] text-muted-foreground">{t("common.comingSoon")}</span>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
