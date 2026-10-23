import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Extra direction for an AI button ("ne planifie rien le vendredi après-midi", "le billet du client X passe en
 * premier"). Kept in memory per place (one ticket, the ticket plan, a day) so the same words follow the
 * buttons of that place until the page is closed; sent as `direction` with the request.
 */
const store = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export function useAiDirection(key: string) {
  const text = useSyncExternalStore(subscribe, () => store.get(key) ?? "");
  const set = (v: string) => {
    store.set(key, v);
    listeners.forEach((fn) => fn());
  };
  const direction = text.trim();
  return { text, set, /** Sent with the request ({} when empty) */ body: direction ? { direction } : {} };
}

export function AiDirection({ id, className }: { id: string; className?: string }) {
  const { t } = useTranslation();
  const d = useAiDirection(id);
  const filled = d.text.trim().length > 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("relative size-8 text-violet-200 hover:bg-violet-500/15", className)}
          aria-label={t("ai.direction.title")}
          title={filled ? d.text.trim() : t("ai.direction.title")}
        >
          <MessageSquarePlus className="size-4" />
          {filled && <span className="absolute right-1 top-1 size-2 rounded-full bg-violet-400" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2">
        <p className="text-sm font-medium">{t("ai.direction.title")}</p>
        <Textarea
          value={d.text}
          maxLength={1000}
          rows={4}
          autoFocus
          placeholder={t("ai.direction.placeholder")}
          onChange={(e) => d.set(e.target.value)}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">{t("ai.direction.hint")}</p>
          {filled && (
            <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={() => d.set("")}>
              {t("ai.direction.clear")}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
