import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Paperclip, Pencil, Plus, Send, Trash2, Wallet } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { money, useCrmClients } from "@/pages/crm/shared";
import { fileToBase64 } from "@/pages/outlook/shared";
import { shortDate } from "@/pages/tickets/shared";

export type ExpenseType = { id: string; name: string; unit: string | null; unitPriceCents: number | null; billable: boolean; ledgerAccountId: string | null; active: boolean };
export type Expense = {
  id: string;
  date: string;
  typeId: string;
  type: string;
  description: string;
  quantityX100: number;
  unitPriceCents: number;
  amountCents: number;
  clientId: string | null;
  clientName: string | null;
  billable: boolean;
  status: "draft" | "submitted" | "approved" | "rejected";
  comment: string | null;
  hasReceipt: boolean;
  receiptName: string | null;
  quickbooksId: string | null;
  quickbooksError: string | null;
};
export const EXPENSE_STATUS_STYLE: Record<Expense["status"], string> = {
  draft: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  submitted: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  approved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  rejected: "border-red-500/40 bg-red-500/10 text-red-300",
};
const MAX_FILE = 5 * 1024 * 1024;

/** My tools › Expenses: claims with their receipt, sent for approval; billable ones go on the client's invoice. */
export function ExpensesPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data: list = [], isLoading } = useQuery({ queryKey: ["time", "expenses"], queryFn: () => api.get<Expense[]>("/time/expenses") });
  const [editing, setEditing] = useState<Expense | "new" | null>(null);
  const m = (c: number) => money(c, i18n.language);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["time", "expenses"] });
  const submit = useMutation({ mutationFn: (id: string) => api.post(`/time/expenses/${id}/submit`), onSuccess: () => (refresh(), toast.success(t("expense.submitted"))) });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/time/expenses/${id}`), onSuccess: refresh });
  const drafts = list.filter((x) => x.status === "draft" || x.status === "rejected");
  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Wallet className="size-6 text-primary" /> {t("expense.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("expense.subtitle")}</p>
        </div>
        <Button onClick={() => setEditing("new")} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
          <Plus className="size-4" /> {t("expense.new")}
        </Button>
      </div>
      {isLoading && <Loader2 className="mx-auto my-10 size-6 animate-spin text-muted-foreground" />}
      {!isLoading && !list.length && <p className="glass rounded-2xl border border-dashed py-14 text-center text-sm text-muted-foreground">{t("expense.none")}</p>}
      {list.length > 0 && (
        <div className="glass overflow-hidden rounded-2xl border">
          <ul className="divide-y divide-border/60">
            {list.map((x) => {
              const open = x.status === "draft" || x.status === "rejected";
              return (
                <li key={x.id} className="grid grid-cols-[80px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-sm md:grid-cols-[90px_minmax(0,1fr)_140px_110px_auto]">
                  <span className="text-xs text-muted-foreground">{shortDate(x.date)}</span>
                  <span className="min-w-0">
                    <span className="block truncate">{x.description}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {[x.type, x.clientName && (x.billable ? t("expense.billedTo", { name: x.clientName }) : x.clientName), x.hasReceipt && t("expense.receipt")].filter(Boolean).join(" · ")}
                    </span>
                    {x.status === "rejected" && x.comment && <span className="block text-[11px] text-red-300">{x.comment}</span>}
                  </span>
                  <span className="hidden md:block">
                    <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px]", EXPENSE_STATUS_STYLE[x.status])}>{t(`expense.status.${x.status}`)}</span>
                  </span>
                  <span className="text-right font-mono">{m(x.amountCents)}</span>
                  <span className="flex justify-end gap-1">
                    {x.hasReceipt && (
                      <a href={`/api/time/expenses/${x.id}/receipt`} target="_blank" rel="noreferrer" className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label={t("expense.receipt")}>
                        <Paperclip className="size-3.5" />
                      </a>
                    )}
                    {open && (
                      <>
                        <button type="button" onClick={() => setEditing(x)} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label={t("expense.edit")}>
                          <Pencil className="size-3.5" />
                        </button>
                        <button type="button" onClick={() => remove.mutate(x.id)} className="rounded p-1 text-muted-foreground hover:text-destructive" aria-label={t("expense.remove")}>
                          <Trash2 className="size-3.5" />
                        </button>
                        <Button size="sm" variant="outline" className="h-7" onClick={() => submit.mutate(x.id)}>
                          <Send className="size-3" /> {t("expense.submit")}
                        </Button>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {drafts.length > 1 && (
        <Button variant="outline" onClick={() => drafts.forEach((x) => submit.mutate(x.id))}>
          <Send className="size-4" /> {t("expense.submitAll", { count: drafts.length })}
        </Button>
      )}
      {editing && <ExpenseDialog expense={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}

function ExpenseDialog({ expense, onClose, onSaved }: { expense: Expense | null; onClose: () => void; onSaved: () => void }) {
  const { t, i18n } = useTranslation();
  const { data: types } = useQuery({ queryKey: ["time", "types"], queryFn: () => api.get<{ expense: ExpenseType[] }>("/time/types") });
  const { data: clients = [] } = useCrmClients();
  const fileInput = useRef<HTMLInputElement>(null);
  const today = new Date().toLocaleDateString("en-CA");
  const [f, setF] = useState({
    date: expense?.date ?? today,
    typeId: expense?.typeId ?? "",
    description: expense?.description ?? "",
    quantity: expense ? String(expense.quantityX100 / 100) : "",
    amount: expense ? (expense.amountCents / 100).toFixed(2) : "",
    clientId: expense?.clientId ?? "",
    billable: expense?.billable ?? false,
  });
  const [file, setFile] = useState<File | null>(null);
  const type = types?.expense.find((x) => x.id === f.typeId);
  const byUnit = Boolean(type?.unit && type.unitPriceCents != null);
  const num = (s: string) => Number(s.replace(",", "."));
  const amount = byUnit ? Math.round(num(f.quantity) * (type!.unitPriceCents ?? 0)) : Math.round(num(f.amount) * 100);
  const save = useMutation({
    mutationFn: async () => {
      const receipt = file ? { name: file.name, contentType: file.type || "application/octet-stream", data: await fileToBase64(file) } : undefined;
      const p = { date: f.date, typeId: f.typeId, description: f.description, ...(byUnit ? { quantity: num(f.quantity) } : { amountCents: amount }), clientId: f.clientId || null, billable: Boolean(f.clientId) && f.billable, ...(receipt ? { receipt } : {}) };
      return expense ? api.patch(`/time/expenses/${expense.id}`, p) : api.post("/time/expenses", p);
    },
    onSuccess: () => {
      onSaved();
      toast.success(t("expense.saved"));
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "Validation failed" ? t("expense.invalid") : t("common.error")),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="size-5 text-primary" /> {expense ? t("expense.edit") : t("expense.new")}
          </DialogTitle>
          <DialogDescription>{t("expense.dialogText")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("expense.date")}</Label>
              <Input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("expense.type")}</Label>
              <Select value={f.typeId} onValueChange={(v) => setF({ ...f, typeId: v, billable: types?.expense.find((x) => x.id === v)?.billable ?? f.billable })}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("expense.pickType")} />
                </SelectTrigger>
                <SelectContent>
                  {(types?.expense ?? []).map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      {x.name}
                      {x.unit && x.unitPriceCents != null && <span className="ml-1 text-xs text-muted-foreground">({money(x.unitPriceCents, i18n.language)}/{x.unit})</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("expense.description")}</Label>
            <Input required maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {byUnit ? (
              <div className="space-y-1.5">
                <Label className="text-xs">{t("expense.quantity", { unit: type!.unit })}</Label>
                <Input required inputMode="decimal" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs">{t("expense.amount")}</Label>
                <Input required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
              </div>
            )}
            <div className="flex items-end pb-2 font-mono text-sm">{Number.isFinite(amount) && amount > 0 ? money(amount, i18n.language) : ""}</div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("expense.client")}</Label>
              <Select value={f.clientId || "none"} onValueChange={(v) => setF({ ...f, clientId: v === "none" ? "" : v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" className="max-h-72">
                  <SelectItem value="none">{t("expense.noClient")}</SelectItem>
                  {clients
                    .filter((c) => c.active)
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <label className={cn("flex items-end gap-2 pb-2 text-sm", !f.clientId && "opacity-50")}>
              <Switch disabled={!f.clientId} checked={Boolean(f.clientId) && f.billable} onCheckedChange={(v) => setF({ ...f, billable: v })} /> {t("expense.billable")}
            </label>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("expense.receipt")}</Label>
            <button type="button" onClick={() => fileInput.current?.click()} className="flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-left text-sm text-muted-foreground hover:border-[color:var(--gold)]/50 hover:text-foreground">
              <Paperclip className="size-4 text-primary" /> {file ? file.name : expense?.receiptName ?? t("expense.pickReceipt")}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,application/pdf"
              hidden
              onChange={(e) => {
                const x = e.target.files?.[0];
                if (x && x.size > MAX_FILE) toast.error(t("expense.tooBig"));
                else setFile(x ?? null);
                e.target.value = "";
              }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!f.typeId || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("expense.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
