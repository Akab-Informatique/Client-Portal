import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleOff, Loader2, MailX } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { LanguageToggle } from "@/components/LanguageToggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative grid min-h-dvh place-items-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <LanguageToggle />
      </div>
      <div className="glass w-full max-w-md space-y-6 rounded-3xl border p-6 text-center sm:p-8">
        <Logo className="mx-auto h-11" />
        {children}
      </div>
    </main>
  );
}

/**
 * /desinscription (no sign-in): the general link of the newsletter. The person types their email; when it is one of
 * ours it is taken off the list. The answer is the same either way (nobody can use it to find out who our contacts are).
 */
function GeneralForm() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const send = useMutation({ mutationFn: () => api.post("/newsletter/public/unsubscribe", { email: email.trim() }) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) send.mutate();
  };
  return (
    <Shell>
      {send.isSuccess ? (
        <div className="space-y-3">
          <CheckCircle2 className="mx-auto size-9 text-emerald-300" />
          <h1 className="text-2xl font-bold">{t("unsubscribe.generalDoneTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("unsubscribe.generalDoneText")}</p>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <MailX className="mx-auto size-9 text-primary" />
          <h1 className="text-2xl font-bold">{t("unsubscribe.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("unsubscribe.generalText")}</p>
          <Input type="email" required autoComplete="email" maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("unsubscribe.emailPh")} aria-label={t("unsubscribe.emailPh")} />
          <Button type="submit" className="w-full" disabled={send.isPending || !email.trim()}>
            {send.isPending && <Loader2 className="size-4 animate-spin" />} {t("unsubscribe.confirm")}
          </Button>
          {send.isError && <p className="text-xs text-red-300">{t("unsubscribe.generalError")}</p>}
        </form>
      )}
    </Shell>
  );
}

/**
 * /desinscription/<signed token> (no sign-in): the personal link at the bottom of the newsletter. It asks for a click
 * before unsubscribing (mail scanners open links by themselves), and can be undone. /desinscription alone is the
 * general link (the person types their email).
 */
export function UnsubscribePage() {
  const token = window.location.pathname.split("/desinscription/")[1]?.replace(/\/$/, "") ?? "";
  return token ? <PersonalLink token={token} /> : <GeneralForm />;
}

function PersonalLink({ token }: { token: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const key = ["newsletter-public", token];
  const { data, isLoading, isError } = useQuery({ queryKey: key, queryFn: () => api.get<{ email: string; unsubscribed: boolean }>(`/newsletter/public/${token}`), retry: false });
  const act = useMutation({
    mutationFn: (what: "unsubscribe" | "resubscribe") => api.post(`/newsletter/public/${token}/${what}`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  return (
    <Shell>
      {isLoading ? (
        <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
      ) : isError || !data ? (
        <div className="space-y-3">
          <CircleOff className="mx-auto size-8 text-muted-foreground" />
          <h1 className="text-xl font-bold">{t("unsubscribe.goneTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("unsubscribe.goneText")}</p>
          <a className="text-sm text-primary underline" href="/desinscription">
            {t("unsubscribe.useGeneral")}
          </a>
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
    </Shell>
  );
}
