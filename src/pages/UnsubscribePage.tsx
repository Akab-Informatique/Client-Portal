import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleOff, Loader2, MailX } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { LanguageToggle } from "@/components/LanguageToggle";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

/**
 * /desinscription/<signed token> (no sign-in): the link at the bottom of the newsletter. It asks for a click before
 * unsubscribing (mail scanners open links by themselves), and can be undone.
 */
export function UnsubscribePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const token = window.location.pathname.split("/desinscription/")[1] ?? "";
  const key = ["newsletter-public", token];
  const { data, isLoading, isError } = useQuery({ queryKey: key, queryFn: () => api.get<{ email: string; unsubscribed: boolean }>(`/newsletter/public/${token}`), retry: false });
  const act = useMutation({
    mutationFn: (what: "unsubscribe" | "resubscribe") => api.post(`/newsletter/public/${token}/${what}`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  return (
    <main className="relative grid min-h-dvh place-items-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <LanguageToggle />
      </div>
      <div className="glass w-full max-w-md space-y-6 rounded-3xl border p-6 text-center sm:p-8">
        <Logo className="mx-auto h-11" />
        {isLoading ? (
          <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
        ) : isError || !data ? (
          <div className="space-y-2">
            <CircleOff className="mx-auto size-8 text-muted-foreground" />
            <h1 className="text-xl font-bold">{t("unsubscribe.goneTitle")}</h1>
            <p className="text-sm text-muted-foreground">{t("unsubscribe.goneText")}</p>
          </div>
        ) : data.unsubscribed ? (
          <div className="space-y-3">
            <CheckCircle2 className="mx-auto size-9 text-emerald-300" />
            <h1 className="text-2xl font-bold">{t("unsubscribe.doneTitle")}</h1>
            <p className="text-sm text-muted-foreground">{t("unsubscribe.doneText", { email: data.email })}</p>
            <Button type="button" variant="ghost" size="sm" disabled={act.isPending} onClick={() => act.mutate("resubscribe")}>
              {t("unsubscribe.undo")}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <MailX className="mx-auto size-9 text-primary" />
            <h1 className="text-2xl font-bold">{t("unsubscribe.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("unsubscribe.text", { email: data.email })}</p>
            <Button type="button" className="w-full" disabled={act.isPending} onClick={() => act.mutate("unsubscribe")}>
              {act.isPending && <Loader2 className="size-4 animate-spin" />} {t("unsubscribe.confirm")}
            </Button>
            {act.isError && <p className="text-xs text-red-300">{t("common.error")}</p>}
          </div>
        )}
      </div>
    </main>
  );
}
