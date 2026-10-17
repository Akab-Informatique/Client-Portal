import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Cpu } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { currentLocale } from "@/i18n";

/**
 * The model next to an AI button: the part's own (set by an admin) unless the
 * technician picks another one, remembered on this computer. Hidden when an
 * admin turned the choice off.
 */
type AiOptions = { models: string[]; allowChoice: boolean; features: Record<string, string>; today: { spentUsd: number; limitUsd: number | null } };
export type AiFeature = "ticket.analyze" | "ticket.reply" | "tickets.plan";

export function useAiOptions() {
  const can = useCan();
  return useQuery({ queryKey: ["ai", "options"], queryFn: () => api.get<AiOptions>("/tickets/ai/options"), enabled: can("tickets.ai"), staleTime: 60_000 });
}

const storeKey = (f: AiFeature) => `akab.ai.model.${f}`;
function readChoice(f: AiFeature): string | null {
  try {
    return localStorage.getItem(storeKey(f));
  } catch {
    return null;
  }
}

/** The model to send for this part (null: the part's own), and how to change it. */
export function useAiModel(feature: AiFeature) {
  const { data } = useAiOptions();
  const [choice, setChoice] = useState<string | null>(() => readChoice(feature));
  const valid = data?.allowChoice && choice && data.models.includes(choice) ? choice : null;
  return {
    options: data,
    /** Sent with the request ({} = the part's own model) */
    body: valid ? { model: valid } : {},
    effective: valid ?? data?.features[feature] ?? null,
    chosen: valid,
    set: (m: string | null) => {
      setChoice(m);
      try {
        if (m) localStorage.setItem(storeKey(feature), m);
        else localStorage.removeItem(storeKey(feature));
      } catch {
        /* private window: kept for this page only */
      }
    },
  };
}

export const shortModel = (m: string | null | undefined) => (!m ? "—" : /haiku/.test(m) ? "Haiku" : /opus/.test(m) ? "Opus" : /sonnet/.test(m) ? "Sonnet" : m);

/** US dollars, short: "0,42 $" / "$0.42". */
function money(usd: number) {
  const en = currentLocale() === "en";
  const n = new Intl.NumberFormat(en ? "en-CA" : "fr-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usd);
  return en ? `$${n}` : `${n} $`;
}

function Choices({ feature, m }: { feature: AiFeature; m: ReturnType<typeof useAiModel> }) {
  const { t } = useTranslation();
  const own = m.options?.features[feature];
  return (
    <>
      <DropdownMenuItem onSelect={() => m.set(null)} className="gap-2 text-xs">
        <Check className={cn("size-3.5", m.chosen ? "opacity-0" : "opacity-100")} />
        {t("ai.picker.default", { model: shortModel(own) })}
      </DropdownMenuItem>
      {(m.options?.models ?? []).map((id) => (
        <DropdownMenuItem key={id} onSelect={() => m.set(id)} className="gap-2 text-xs">
          <Check className={cn("size-3.5", m.chosen === id ? "opacity-100" : "opacity-0")} />
          {shortModel(id)}
          <span className="ml-auto text-[10px] text-muted-foreground">{t(`ai.picker.tier.${shortModel(id).toLowerCase()}`, { defaultValue: "" })}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** Inside an AI menu: "<part> : <model> ›" with the choices. */
export function AiModelSub({ feature, label, m }: { feature: AiFeature; label: string; m: ReturnType<typeof useAiModel> }) {
  if (!m.options?.allowChoice) return null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2 text-xs">
        <Cpu className="size-3.5 text-muted-foreground" />
        <span className="flex-1">{label}</span>
        <span className={cn("text-[11px]", m.chosen ? "text-primary" : "text-muted-foreground")}>{shortModel(m.effective)}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-52">
        <Choices feature={feature} m={m} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** Today's AI spending of the technician (in the AI menus), when there is a limit. */
export function AiTodayLine() {
  const { t } = useTranslation();
  const { data } = useAiOptions();
  if (!data || data.today.limitUsd === null) return null;
  return <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">{t("ai.picker.today", { spent: money(data.today.spentUsd), limit: money(data.today.limitUsd) })}</DropdownMenuLabel>;
}

/** Beside a single AI button: a small ▾ with the model choices. */
export function AiModelButton({ feature, m, className }: { feature: AiFeature; m: ReturnType<typeof useAiModel>; className?: string }) {
  const { t } = useTranslation();
  if (!m.options?.allowChoice) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn("flex h-9 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground", m.chosen && "text-primary", className)}
          aria-label={t("ai.picker.title")}
          title={t("ai.picker.title")}
        >
          {shortModel(m.effective)}
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs">{t("ai.picker.title")}</DropdownMenuLabel>
        <AiTodayLine />
        <DropdownMenuSeparator />
        <Choices feature={feature} m={m} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
