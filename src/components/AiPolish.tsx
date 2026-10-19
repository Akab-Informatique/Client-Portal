import { forwardRef, useState, type ChangeEvent, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChevronDown, Loader2, WandSparkles } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";

type Lang = "fr" | "en";

/** A text corrected by the AI (language and structure), French unless asked otherwise. */
export function usePolish() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const run = async (text: string, format: "text" | "html", lang: Lang): Promise<string | null> => {
    if (!text.trim()) return null;
    setBusy(true);
    try {
      return (await api.post<{ text: string }>("/tickets/ai/polish", { text, format, lang })).text;
    } catch (e) {
      const code = e instanceof ApiError ? e.code.replace(/^ai_/, "") : "";
      toast.error(t(`tickets.ai.errors.${code}`, { defaultValue: t("tickets.ai.errors.api") }));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}

/**
 * The ✨ button next to a long text: one click corrects it in French; the
 * arrow offers English. The change can be undone from the toast.
 */
export function AiPolishButton({
  get,
  set,
  format = "text",
  className,
  disabled,
}: {
  get: () => string;
  set: (text: string) => void;
  format?: "text" | "html";
  className?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const can = useCan();
  const { run, busy } = usePolish();
  if (!can("tickets.ai")) return null;
  const go = async (lang: Lang) => {
    const before = get();
    const next = await run(before, format, lang);
    if (next === null) return;
    set(next);
    toast.success(t("ai.polished"), { action: { label: t("ai.undo"), onClick: () => set(before) } });
  };
  return (
    <span className={cn("inline-flex items-center rounded-md border bg-background/80 shadow-sm backdrop-blur", className)}>
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => void go("fr")}
        title={t("ai.polishHint")}
        aria-label={t("ai.polish")}
        className="flex h-7 items-center gap-1 rounded-l-md px-2 text-[11px] font-medium text-primary hover:bg-[color:var(--gold)]/10 disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <WandSparkles className="size-3.5" />}
        <span className="hidden sm:inline">{t("ai.polish")}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled || busy}
            aria-label={t("ai.polishOther")}
            className="flex h-7 items-center rounded-r-md border-l px-1 text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void go("fr")}>{t("ai.polishFr")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void go("en")}>{t("ai.polishEn")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/** A textarea with the ✨ button in its corner (for those with the AI right). */
export const AiTextarea = forwardRef<HTMLTextAreaElement, ComponentProps<typeof Textarea> & { value: string }>(function AiTextarea({ className, value, onChange, disabled, ...props }, ref) {
  const set = (text: string) => onChange?.({ target: { value: text }, currentTarget: { value: text } } as unknown as ChangeEvent<HTMLTextAreaElement>);
  return (
    <div className="relative">
      <Textarea ref={ref} value={value} onChange={onChange} disabled={disabled} className={cn("pb-9", className)} {...props} />
      <AiPolishButton get={() => value} set={set} disabled={disabled || !value.trim()} className="absolute bottom-1.5 right-1.5" />
    </div>
  );
});
