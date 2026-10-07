import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/session";

export function ProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: me.name, title: me.title ?? "", phone: me.phone ?? "", notifyEmail: me.notifyEmail });
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);

  useEffect(() => {
    if (open) setForm({ name: me.name, title: me.title ?? "", phone: me.phone ?? "", notifyEmail: me.notifyEmail });
  }, [open, me]);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch("/me", form);
      await qc.invalidateQueries({ queryKey: ["auth"] });
      toast.success(t("common.saved"));
    } catch {
      toast.error(t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (pw.next !== pw.confirm) return toast.error(t("password.mismatch"));
    if (pw.next.length < 12) return toast.error(t("password.short"));
    setPwBusy(true);
    try {
      await api.post("/auth/password", { current: pw.current, next: pw.next });
      setPw({ current: "", next: "", confirm: "" });
      toast.success(t("password.changed"));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      toast.error(code === "wrong_password" ? t("password.wrong") : code === "password_same" ? t("password.same") : t("common.error"));
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("topbar.profile")}</DialogTitle>
          <DialogDescription>{me.email}</DialogDescription>
        </DialogHeader>
        <form onSubmit={saveProfile} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="p-name">{t("common.name")}</Label>
            <Input id="p-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="p-title">{t("common.title")}</Label>
              <Input id="p-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-phone">{t("common.phone")}</Label>
              <Input id="p-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
          </div>
          {me.kind === "client" && (
            <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm">
              {t("admin.users.notify")}
              <Switch checked={form.notifyEmail} onCheckedChange={(v) => setForm({ ...form, notifyEmail: v })} />
            </label>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
            </Button>
          </div>
        </form>
        <Separator />
        <form onSubmit={changePassword} className="space-y-3">
          <p className="font-display text-sm font-semibold">{t("password.next")}</p>
          <Input type="password" autoComplete="current-password" placeholder={t("password.current")} required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input type="password" autoComplete="new-password" placeholder={t("password.next")} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            <Input type="password" autoComplete="new-password" placeholder={t("password.confirm")} required value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          </div>
          <p className="text-xs text-muted-foreground">{t("password.rule")}</p>
          <div className="flex justify-end">
            <Button type="submit" variant="outline" disabled={pwBusy}>
              {pwBusy && <Loader2 className="size-4 animate-spin" />} {t("password.submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
