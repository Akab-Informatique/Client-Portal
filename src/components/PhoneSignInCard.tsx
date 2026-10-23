import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Smartphone, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { enrollThisPhone, forgetDevice, pushSupport, storedDevice } from "@/lib/push";

type Devices = { vapidPublicKey: string; devices: { id: string; label: string; createdAt: string; lastUsedAt: string | null; userAgent: string }[] };

/**
 * Profile › Sign in with my phone: the phones that approve sign-ins with a notification (number matching + the phone's
 * passkey). Adding this phone asks for the password again; open the portal on the phone itself to add it.
 */
export function PhoneSignInCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const support = pushSupport();
  const mine = storedDevice();
  const { data } = useQuery({ queryKey: ["push-devices"], queryFn: () => api.get<Devices>("/auth/push/devices") });
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [open, setOpen] = useState(false);
  const enroll = useMutation({
    mutationFn: () => enrollThisPhone({ password, label }),
    onSuccess: () => {
      setPassword("");
      setLabel("");
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["push-devices"] });
      toast.success(t("phoneLogin.added"));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "wrong_password") toast.error(t("phoneLogin.wrongPassword"));
      else if (e instanceof Error && e.message === "notifications_denied") toast.error(t("phoneLogin.notificationsDenied"));
      else if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError")) toast.error(t("phoneLogin.cancelled"));
      else if (e instanceof DOMException && e.name === "InvalidStateError") toast.error(t("phoneLogin.alreadyHere"));
      else toast.error(t("phoneLogin.enrollFailed"));
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/auth/push/devices/${id}`),
    onSuccess: (_r, id) => {
      if (mine?.deviceId === id) forgetDevice();
      void qc.invalidateQueries({ queryKey: ["push-devices"] });
      toast.success(t("phoneLogin.removed"));
    },
    onError: () => toast.error(t("common.error")),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password && !enroll.isPending) enroll.mutate();
  };
  return (
    <section className="rounded-2xl border bg-background/40 p-4">
      <h3 className="mb-1 flex items-center gap-2 font-display text-sm font-semibold">
        <Smartphone className="size-4 text-primary" /> {t("phoneLogin.title")}
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">{t("phoneLogin.text")}</p>
      <ul className="mb-3 space-y-1.5">
        {(data?.devices ?? []).map((d) => (
          <li key={d.id} className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm">
            <Smartphone className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {d.label}
                {mine?.deviceId === d.id && <span className="ml-2 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">{t("phoneLogin.thisOne")}</span>}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {t("phoneLogin.addedOn", { date: new Date(d.createdAt).toLocaleDateString() })}
                {d.lastUsedAt ? ` · ${t("phoneLogin.lastUsed", { date: new Date(d.lastUsedAt).toLocaleDateString() })}` : ""}
              </span>
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-destructive"
              aria-label={t("common.delete")}
              onClick={() => void confirm({ title: t("phoneLogin.removeTitle", { name: d.label }), description: t("phoneLogin.removeText"), confirmLabel: t("common.delete"), destructive: true }).then((ok) => ok && remove.mutate(d.id))}
            >
              <Trash2 className="size-4" />
            </Button>
          </li>
        ))}
        {data && data.devices.length === 0 && <li className="text-xs text-muted-foreground">{t("phoneLogin.none")}</li>}
      </ul>
      {support === "ok" ? (
        open ? (
          <form onSubmit={submit} className="space-y-3 rounded-xl border bg-background/50 p-3">
            <p className="text-xs text-muted-foreground">{t("phoneLogin.thisPhoneHint")}</p>
            <div className="space-y-1.5">
              <Label htmlFor="pl-label">{t("phoneLogin.name")}</Label>
              <Input id="pl-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("phoneLogin.namePlaceholder")} maxLength={60} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pl-pass">{t("phoneLogin.password")}</Label>
              <Input id="pl-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" size="sm" disabled={!password || enroll.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
                {enroll.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("phoneLogin.enable")}
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Smartphone className="size-4" /> {t("phoneLogin.addThis")}
          </Button>
        )
      ) : (
        <p className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">{support === "ios-install" ? t("phoneLogin.iosInstall") : t("phoneLogin.unsupported")}</p>
      )}
    </section>
  );
}
