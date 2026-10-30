import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ClipboardPaste, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";

type Frequency = "weekly" | "monthly" | "yearly";
export type Recurring = {
  id: string;
  name: string;
  amountCents: number | null;
  frequency: Frequency;
  dayOfMonth: number | null;
  weekday: number | null;
  month: number | null;
  account: string | null;
  method: string | null;
  notes: string | null;
  inQuickbooks: boolean;
  active: boolean;
};
type Preview = { rows: { name: string; amountCents: number | null; frequency: Frequency; dayOfMonth: number | null }[]; skipped: number; added: number; alreadyThere: number; applied: boolean };

const key = ["vendor-bills", "recurring"];
/** What a recurring payment lacks to be counted by the forecast, if anything */
const missing = (r: Recurring) => (r.amountCents === null ? "amount" : r.frequency !== "weekly" && !r.dayOfMonth ? "day" : r.frequency === "yearly" && !r.month ? "month" : null);

/** Accounting › Paiements fournisseurs › Paiements récurrents: rent, insurance, subscriptions, payroll… counted by the forecast. */
export function RecurringPayments() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const can = useCan();
  const manage = can("accounting.manage");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const list = useQuery({ queryKey: key, queryFn: () => api.get<Recurring[]>("/vendor-payments/recurring") });
  const [editing, setEditing] = useState<Recurring | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["vendor-bills", "forecast"] });
  };
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/vendor-payments/recurring/${id}`),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: (r: Recurring) => api.patch(`/vendor-payments/recurring/${r.id}`, { active: !r.active }),
    onSuccess: refresh,
  });

  const rows = list.data ?? [];
  const perMonth = rows
    .filter((r) => r.active && !r.inQuickbooks && r.amountCents)
    .reduce((x, r) => x + (r.amountCents ?? 0) * (r.frequency === "weekly" ? 52 / 12 : r.frequency === "yearly" ? 1 / 12 : 1), 0);
  const when = (r: Recurring) =>
    r.frequency === "weekly"
      ? t("vendorBills.recurring.everyWeek", { day: t(`vendorBills.recurring.weekdays.${r.weekday ?? 5}`) })
      : r.frequency === "yearly"
        ? r.dayOfMonth && r.month
          ? t("vendorBills.recurring.everyYear", { day: r.dayOfMonth, month: t(`vendorBills.recurring.months.${r.month}`) })
          : t("vendorBills.recurring.yearly")
        : r.dayOfMonth
          ? t("vendorBills.recurring.everyMonth", { day: r.dayOfMonth })
          : t("vendorBills.recurring.monthly");

  return (
    <section className="glass space-y-3 rounded-2xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("vendorBills.recurring.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("vendorBills.recurring.subtitle")}</p>
        </div>
        {manage && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setImporting(true)}>
              <ClipboardPaste className="size-3.5" /> {t("vendorBills.recurring.import")}
            </Button>
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus className="size-3.5" /> {t("vendorBills.recurring.add")}
            </Button>
          </div>
        )}
      </div>
      {rows.length > 0 && <p className="text-sm text-muted-foreground">{t("vendorBills.recurring.perMonth", { amount: money(Math.round(perMonth), lang) })}</p>}

      {list.isLoading ? (
        <Skeleton className="h-40" />
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("vendorBills.recurring.none")}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-background/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t("vendorBills.recurring.name")}</th>
                <th className="px-3 py-2">{t("vendorBills.recurring.when")}</th>
                <th className="px-3 py-2">{t("vendorBills.recurring.account")}</th>
                <th className="px-3 py-2 text-right">{t("vendorBills.forecast.amount")}</th>
                {manage && <th className="w-24 px-3 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => {
                const lack = missing(r);
                return (
                  <tr key={r.id} className={cn(!r.active && "opacity-50")}>
                    <td className="px-3 py-1.5">
                      <p className="font-medium">{r.name}</p>
                      {r.notes && <p className="text-xs text-muted-foreground">{r.notes}</p>}
                      {r.inQuickbooks && <p className="text-xs text-sky-300">{t("vendorBills.recurring.inQb")}</p>}
                      {lack && r.active && <p className="text-xs text-amber-300">{t(`vendorBills.recurring.missing.${lack}`)}</p>}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">{when(r)}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {[r.account, r.method].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.amountCents === null ? "—" : money(r.amountCents, lang)}</td>
                    {manage && (
                      <td className="px-3 py-1.5">
                        <div className="flex items-center justify-end gap-1">
                          <Switch checked={r.active} onCheckedChange={() => toggle.mutate(r)} aria-label={t("vendorBills.recurring.active")} />
                          <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(r)} aria-label={t("vendorBills.recurring.edit")}>
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            aria-label={t("vendorBills.recurring.delete")}
                            onClick={async () => {
                              if (await confirm({ title: t("vendorBills.recurring.deleteTitle", { name: r.name }), confirmLabel: t("vendorBills.recurring.delete"), destructive: true })) remove.mutate(r.id);
                            }}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && <EditDialog item={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={refresh} />}
    </section>
  );
}

function EditDialog({ item, onClose, onSaved }: { item: Recurring | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({
    name: item?.name ?? "",
    amount: item?.amountCents != null ? String(item.amountCents / 100) : "",
    frequency: (item?.frequency ?? "monthly") as Frequency,
    day: item?.dayOfMonth ? String(item.dayOfMonth) : "",
    weekday: String(item?.weekday ?? 5),
    month: item?.month ? String(item.month) : "",
    account: item?.account ?? "",
    method: item?.method ?? "",
    notes: item?.notes ?? "",
    inQuickbooks: item?.inQuickbooks ?? false,
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = useMutation({
    mutationFn: () => {
      const amount = f.amount.trim() === "" ? null : Math.round(Number(f.amount.replace(/[\s$]/g, "").replace(",", ".")) * 100);
      const body = {
        name: f.name,
        amountCents: amount !== null && Number.isFinite(amount) ? amount : null,
        frequency: f.frequency,
        dayOfMonth: f.frequency === "weekly" || !f.day ? null : Number(f.day),
        weekday: f.frequency === "weekly" ? Number(f.weekday) : null,
        month: f.frequency === "yearly" && f.month ? Number(f.month) : null,
        account: f.account,
        method: f.method,
        notes: f.notes,
        inQuickbooks: f.inQuickbooks,
      };
      return item ? api.patch(`/vendor-payments/recurring/${item.id}`, body) : api.post("/vendor-payments/recurring", body);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: () => toast.error(t("vendorBills.recurring.saveFailed")),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(item ? "vendorBills.recurring.edit" : "vendorBills.recurring.add")}</DialogTitle>
          <DialogDescription>{t("vendorBills.recurring.formHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (f.name.trim()) save.mutate();
          }}
        >
          <div className="space-y-1 sm:col-span-2">
            <Label>{t("vendorBills.recurring.name")}</Label>
            <Input autoFocus value={f.name} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>{t("vendorBills.forecast.amount")}</Label>
            <Input inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })} placeholder="0,00" />
          </div>
          <div className="space-y-1">
            <Label>{t("vendorBills.recurring.frequency")}</Label>
            <Select value={f.frequency} onValueChange={(v) => set({ frequency: v as Frequency })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["weekly", "monthly", "yearly"] as const).map((x) => (
                  <SelectItem key={x} value={x}>
                    {t(`vendorBills.recurring.freq.${x}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {f.frequency === "weekly" ? (
            <div className="space-y-1">
              <Label>{t("vendorBills.recurring.weekday")}</Label>
              <Select value={f.weekday} onValueChange={(v) => set({ weekday: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {t(`vendorBills.recurring.weekdays.${n}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <>
              {f.frequency === "yearly" && (
                <div className="space-y-1">
                  <Label>{t("vendorBills.recurring.month")}</Label>
                  <Select value={f.month || "none"} onValueChange={(v) => set({ month: v === "none" ? "" : v })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">—</SelectItem>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {t(`vendorBills.recurring.months.${n}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1">
                <Label>{t("vendorBills.recurring.dayOfMonth")}</Label>
                <Input inputMode="numeric" value={f.day} onChange={(e) => set({ day: e.target.value.replace(/\D/g, "").slice(0, 2) })} placeholder="1–31" />
              </div>
            </>
          )}
          <div className="space-y-1">
            <Label>{t("vendorBills.recurring.accountLabel")}</Label>
            <Input value={f.account} onChange={(e) => set({ account: e.target.value })} placeholder="Compte AKAB" />
          </div>
          <div className="space-y-1">
            <Label>{t("vendorBills.recurring.method")}</Label>
            <Input value={f.method} onChange={(e) => set({ method: e.target.value })} placeholder="Prélèvement" />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label>{t("vendorBills.recurring.notes")}</Label>
            <Input value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
          </div>
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <Switch checked={f.inQuickbooks} onCheckedChange={(v) => set({ inQuickbooks: v })} />
            <span>
              <span className="block font-medium">{t("vendorBills.recurring.inQbLabel")}</span>
              <span className="block text-xs text-muted-foreground">{t("vendorBills.recurring.inQbHint")}</span>
            </span>
          </label>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("vendorBills.recurring.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending || !f.name.trim()}>
              {save.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("vendorBills.forecast.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Paste the spreadsheet's lines (copied from Excel): a preview first, then the lines are added. */
function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const run = useMutation({
    mutationFn: (apply: boolean) => api.post<Preview>("/vendor-payments/recurring/import", { text, apply }),
    onSuccess: (r) => {
      setPreview(r);
      if (r.applied) {
        toast.success(t("vendorBills.recurring.imported", { count: r.added }));
        onDone();
        onClose();
      }
    },
    onError: () => toast.error(t("vendorBills.recurring.importFailed")),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("vendorBills.recurring.import")}</DialogTitle>
          <DialogDescription>{t("vendorBills.recurring.importHint")}</DialogDescription>
        </DialogHeader>
        <Textarea
          rows={8}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
          }}
          placeholder={t("vendorBills.recurring.importPlaceholder")}
          className="font-mono text-xs"
        />
        {preview && (
          <div className="max-h-56 overflow-auto rounded-xl border text-sm">
            <p className="border-b px-3 py-2 text-xs text-muted-foreground">{t("vendorBills.recurring.previewCount", { count: preview.rows.length, there: preview.alreadyThere })}</p>
            <ul className="divide-y">
              {preview.rows.map((r, i) => (
                <li key={i} className="flex justify-between gap-3 px-3 py-1">
                  <span className="truncate">{r.name}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {r.amountCents === null ? "?" : money(r.amountCents, i18n.language)} · {r.frequency === "weekly" ? t("vendorBills.recurring.freq.weekly") : r.dayOfMonth ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("vendorBills.recurring.cancel")}
          </Button>
          <Button variant="outline" disabled={!text.trim() || run.isPending} onClick={() => run.mutate(false)}>
            {t("vendorBills.recurring.preview")}
          </Button>
          <Button disabled={!preview || preview.rows.length - preview.alreadyThere === 0 || run.isPending} onClick={() => run.mutate(true)}>
            {run.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("vendorBills.recurring.importApply", { count: preview ? preview.rows.length - preview.alreadyThere : 0 })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
