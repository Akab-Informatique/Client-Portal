import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Handshake, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { DEFAULT_RATE_PER_USER_CENTS, LOST_REASONS, SALES_KINDS, SALES_SOURCES, SALES_STAGES, STAGE_PROBABILITY, type SalesStage } from "@shared/sales";
import { salesError, shortMoney, useSalesClients, useSalesStaff, type Opportunity } from "./shared";

const dollars = (s: string) => {
  const n = Number(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && s.trim() ? Math.round(n * 100) : null;
};
const fromCents = (c: number | null | undefined) => (c == null ? "" : String(c / 100).replace(".", ","));

/** Add or change an opportunity. `stage` starts a new one in a column of the board. */
export function OpportunityDialog({ opp, stage, onClose }: { opp?: Opportunity | null; stage?: SalesStage; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: staff = [] } = useSalesStaff();
  const { data: clients = [] } = useSalesClients();
  const [f, setF] = useState({
    companyName: opp?.companyName ?? "",
    clientId: opp?.clientId ?? "",
    contactName: opp?.contactName ?? "",
    contactEmail: opp?.contactEmail ?? "",
    contactPhone: opp?.contactPhone ?? "",
    source: opp?.source ?? "referral",
    kind: opp?.kind ?? "recurring",
    users: opp?.users != null ? String(opp.users) : "",
    rate: fromCents(opp?.ratePerUserCents ?? DEFAULT_RATE_PER_USER_CENTS),
    oneTime: fromCents(opp?.oneTimeCents),
    stage: (opp?.stage ?? stage ?? "lead") as SalesStage,
    probability: String(opp?.probability ?? STAGE_PROBABILITY[opp?.stage ?? stage ?? "lead"]),
    openedOn: opp?.openedOn ?? "",
    quoteSentOn: opp?.quoteSentOn ?? "",
    closedOn: opp?.closedOn ?? "",
    nextFollowUp: opp?.nextFollowUp ?? "",
    lostReason: opp?.lostReason ?? "",
    notes: opp?.notes ?? "",
    ownerId: opp ? (opp.ownerId ?? "") : me.id,
  });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const recurring = f.kind === "recurring";
  const users = Number(f.users) || 0;
  const rate = dollars(f.rate) ?? 0;
  const closed = f.stage === "won" || f.stage === "lost";

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        companyName: f.companyName.trim(),
        clientId: f.clientId || null,
        contactName: f.contactName,
        contactEmail: f.contactEmail,
        contactPhone: f.contactPhone,
        source: f.source,
        kind: f.kind,
        users: recurring && f.users.trim() ? users : null,
        ratePerUserCents: rate,
        oneTimeCents: recurring ? null : dollars(f.oneTime),
        stage: f.stage,
        probability: Math.min(100, Math.max(0, Number(f.probability) || 0)),
        ...(f.openedOn ? { openedOn: f.openedOn } : {}),
        quoteSentOn: f.quoteSentOn || null,
        // left empty on a won / lost deal: the server dates it today
        ...(closed && f.closedOn ? { closedOn: f.closedOn } : {}),
        nextFollowUp: closed ? null : f.nextFollowUp || null,
        lostReason: f.stage === "lost" ? f.lostReason || null : null,
        notes: f.notes,
        ownerId: f.ownerId || null,
      };
      return opp ? api.patch<Opportunity>(`/sales/opportunities/${opp.id}`, payload) : api.post<Opportunity>("/sales/opportunities", payload);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sales"] });
      toast.success(opp ? t("sales.saved") : t("sales.created"));
      onClose();
    },
    onError: (e) => toast.error(salesError(e, t)),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/sales/opportunities/${opp!.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sales"] });
      toast.success(t("sales.deleted"));
      onClose();
    },
    onError: (e) => toast.error(salesError(e, t)),
  });
  const editable = useCan()("opportunities.edit");
  const valid = editable && f.companyName.trim() && (f.stage !== "lost" || f.lostReason);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Handshake className="size-5 text-primary" /> {opp ? opp.companyName : t("sales.newTitle")}
          </DialogTitle>
          <DialogDescription>{t("sales.dialogText")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="so-company">{t("sales.f.company")}</Label>
              <Input id="so-company" autoFocus required maxLength={200} value={f.companyName} onChange={(e) => set("companyName")(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("sales.f.crmClient")}</Label>
              <Select
                value={f.clientId || "none"}
                onValueChange={(v) => {
                  const c = clients.find((x) => x.id === v);
                  setF((x) => ({ ...x, clientId: c?.id ?? "", companyName: c && !x.companyName.trim() ? c.name : x.companyName }));
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="none">{t("sales.f.noClient")}</SelectItem>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="so-contact">{t("sales.f.contact")}</Label>
              <Input id="so-contact" maxLength={200} value={f.contactName} onChange={(e) => set("contactName")(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="so-email">{t("sales.f.email")}</Label>
                <Input id="so-email" type="email" maxLength={254} value={f.contactEmail} onChange={(e) => set("contactEmail")(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="so-phone">{t("sales.f.phone")}</Label>
                <Input id="so-phone" type="tel" maxLength={40} value={f.contactPhone} onChange={(e) => set("contactPhone")(e.target.value)} />
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-3 rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div role="radiogroup" aria-label={t("sales.f.kind")} className="inline-flex rounded-lg border p-0.5">
                {SALES_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={f.kind === k}
                    onClick={() => set("kind")(k)}
                    className={cn("rounded-md px-3 py-1.5 text-sm transition-colors", f.kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    {t(`sales.kind.${k}`)}
                  </button>
                ))}
              </div>
              <p className="text-sm text-muted-foreground">
                {recurring ? (
                  <>
                    {t("sales.f.monthlyValue")} <strong className="text-base tabular-nums text-foreground">{shortMoney(users * rate, i18n.language)}</strong>
                    {t("sales.perMonth")}
                  </>
                ) : (
                  t("sales.kindHint.one_time")
                )}
              </p>
            </div>
            {recurring ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="so-users">{t("sales.f.users")}</Label>
                  <Input id="so-users" inputMode="numeric" value={f.users} onChange={(e) => set("users")(e.target.value.replace(/\D/g, ""))} placeholder="10" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="so-rate">{t("sales.f.rate")}</Label>
                  <Input id="so-rate" inputMode="decimal" value={f.rate} onChange={(e) => set("rate")(e.target.value)} />
                </div>
              </div>
            ) : (
              <div className="space-y-1.5 sm:max-w-xs">
                <Label htmlFor="so-once">{t("sales.f.oneTime")}</Label>
                <Input id="so-once" inputMode="decimal" value={f.oneTime} onChange={(e) => set("oneTime")(e.target.value)} placeholder="4 500" />
              </div>
            )}
          </fieldset>

          <fieldset className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>{t("sales.f.stage")}</Label>
              <Select
                value={f.stage}
                onValueChange={(v) => {
                  const s = v as SalesStage;
                  setF((x) => ({ ...x, stage: s, probability: String(STAGE_PROBABILITY[s]) }));
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SALES_STAGES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`sales.stage.${s}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="so-prob">{t("sales.f.probability")}</Label>
              <Input id="so-prob" inputMode="numeric" value={f.probability} onChange={(e) => set("probability")(e.target.value.replace(/\D/g, "").slice(0, 3))} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("sales.f.source")}</Label>
              <Select value={f.source} onValueChange={set("source")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SALES_SOURCES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`sales.source.${s}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {f.stage === "lost" && (
              <div className="space-y-1.5 sm:col-span-3">
                <Label>{t("sales.f.lostReason")}</Label>
                <Select value={f.lostReason || undefined} onValueChange={set("lostReason")}>
                  <SelectTrigger className={cn(!f.lostReason && "border-red-400/60")}>
                    <SelectValue placeholder={t("sales.f.lostReasonPick")} />
                  </SelectTrigger>
                  <SelectContent>
                    {LOST_REASONS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {t(`sales.lost.${r}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </fieldset>

          <fieldset className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="so-opened">{t("sales.f.openedOn")}</Label>
              <Input id="so-opened" type="date" value={f.openedOn} onChange={(e) => set("openedOn")(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="so-quote">{t("sales.f.quoteSentOn")}</Label>
              <Input id="so-quote" type="date" value={f.quoteSentOn} onChange={(e) => set("quoteSentOn")(e.target.value)} />
            </div>
            {closed ? (
              <div className="space-y-1.5">
                <Label htmlFor="so-closed">{t("sales.f.closedOn")}</Label>
                <Input id="so-closed" type="date" value={f.closedOn} onChange={(e) => set("closedOn")(e.target.value)} />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="so-follow">{t("sales.f.nextFollowUp")}</Label>
                <Input id="so-follow" type="date" value={f.nextFollowUp} onChange={(e) => set("nextFollowUp")(e.target.value)} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label>{t("sales.f.owner")}</Label>
              <Select value={f.ownerId || "none"} onValueChange={(v) => set("ownerId")(v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("sales.f.noOwner")}</SelectItem>
                  {staff.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </fieldset>
          {!opp && <p className="-mt-2 text-xs text-muted-foreground">{t("sales.f.datesHint")}</p>}

          <div className="space-y-1.5">
            <Label htmlFor="so-notes">{t("sales.f.notes")}</Label>
            <Textarea id="so-notes" rows={3} maxLength={4000} value={f.notes} onChange={(e) => set("notes")(e.target.value)} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            {opp && editable ? (
              <Button
                type="button"
                variant="ghost"
                className="text-red-400 hover:text-red-300"
                disabled={remove.isPending}
                onClick={async () => {
                  if (await confirm({ title: t("sales.deleteTitle"), description: t("sales.deleteText", { name: opp.companyName }), destructive: true })) remove.mutate();
                }}
              >
                <Trash2 className="size-4" /> {t("common.delete")}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" className={cn(!editable && "hidden")} disabled={!valid || save.isPending}>
                {save.isPending && <Loader2 className="size-4 animate-spin" />} {opp ? t("common.save") : t("sales.add")}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
