import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Clock, Lock, Plus, Send, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./sections";

type TimeType = { id: string; name: string; kind: "labour" | "workday" | "bankpay" | "other"; active: boolean; billable: boolean; quickbooksItemId: string | null };
type ExpenseType = { id: string; name: string; ledgerAccountId: string | null; unit: string | null; unitPriceCents: number | null; billable: boolean; active: boolean };
type Account = { id: string; number: string; name: string; type: string; active: boolean };
const KEY = ["admin", "time-types"];

/** What happens when a week or an expense report is sent: approved at once, and the PDF to accounting. */
function ReportSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const key = ["admin", "time-report-settings"];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<{ autoApprove: boolean; recipients: string[] }>("/time/admin/report-settings") });
  const [to, setTo] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (p: { autoApprove?: boolean; recipients?: string[] }) => api.put("/time/admin/report-settings", p),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      setTo(null);
      toast.success(t("timeReports.saved"));
    },
    onError: () => toast.error(t("common.error")),
  });
  if (!data) return null;
  const text = to ?? data.recipients.join("\n");
  return (
    <section className="space-y-3 rounded-2xl border bg-card/40 p-5">
      <div>
        <h3 className="flex items-center gap-2 font-semibold">
          <Send className="size-4 text-primary" /> {t("timeReports.title")}
        </h3>
        <p className="text-xs text-muted-foreground">{t("timeReports.text")}</p>
      </div>
      <label className="flex items-center gap-3 text-sm">
        <Switch checked={data.autoApprove} onCheckedChange={(v) => save.mutate({ autoApprove: v })} aria-label={t("timeReports.auto")} />
        <span>
          {t("timeReports.auto")}
          <span className="block text-xs text-muted-foreground">{t("timeReports.autoHint")}</span>
        </span>
      </label>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t("timeReports.recipients")}</p>
        <Textarea rows={2} value={text} onChange={(e) => setTo(e.target.value)} placeholder="comptabilite@akab.ca" />
        <p className="text-xs text-muted-foreground">{t("timeReports.recipientsHint")}</p>
        <Button size="sm" disabled={to === null || save.isPending} onClick={() => save.mutate({ recipients: text.split(/[\s,;]+/).filter(Boolean) })}>
          {t("timeReports.save")}
        </Button>
      </div>
    </section>
  );
}

/** Admin › Temps et dépenses: the kinds of timesheet entries and of expenses. */
export function TimeExpenseSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: KEY, queryFn: () => api.get<{ time: TimeType[]; expense: ExpenseType[] }>("/time/admin/types") });
  const { data: accounts = [] } = useQuery({ queryKey: ["admin", "billing", "ledger"], queryFn: () => api.get<Account[]>("/billing/ledger") });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: ["time", "types"] });
  };
  const fail = () => toast.error(t("common.error"));
  const patchTime = useMutation({ mutationFn: ({ id, ...p }: Partial<TimeType> & { id: string }) => api.patch(`/time/admin/timesheet-types/${id}`, p), onSuccess: refresh, onError: fail });
  const patchExpense = useMutation({ mutationFn: ({ id, ...p }: Partial<ExpenseType> & { id: string }) => api.patch(`/time/admin/expense-types/${id}`, p), onSuccess: refresh, onError: fail });
  const [newTime, setNewTime] = useState("");
  const addTime = useMutation({ mutationFn: () => api.post("/time/admin/timesheet-types", { name: newTime }), onSuccess: () => (refresh(), setNewTime("")), onError: fail });
  const [nx, setNx] = useState({ name: "", unit: "", rate: "", ledgerAccountId: "", billable: false });
  const addExpense = useMutation({
    mutationFn: () => api.post("/time/admin/expense-types", { name: nx.name, unit: nx.unit || null, unitPriceCents: nx.unit && nx.rate ? Math.round(Number(nx.rate.replace(",", ".")) * 100) : null, ledgerAccountId: nx.ledgerAccountId || null, billable: nx.billable }),
    onSuccess: () => (refresh(), setNx({ name: "", unit: "", rate: "", ledgerAccountId: "", billable: false })),
    onError: fail,
  });
  const expenseAccounts = accounts.filter((a) => a.active);

  return (
    <div className="space-y-6">
      <SectionHeader title={t("timeAdmin.title")} subtitle={t("timeAdmin.subtitle")} />

      <ReportSettings />

      <section className="space-y-3 rounded-2xl border bg-card/40 p-5">
        <div>
          <h3 className="flex items-center gap-2 font-semibold">
            <Clock className="size-4 text-primary" /> {t("timeAdmin.timeTitle")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("timeAdmin.timeText")}</p>
        </div>
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
          {(data?.time ?? []).map((x) => (
            <li key={x.id} className={cn("flex items-center gap-3 px-3 py-2", !x.active && "opacity-50")}>
              <Input defaultValue={x.name} onBlur={(e) => e.target.value.trim() && e.target.value !== x.name && patchTime.mutate({ id: x.id, name: e.target.value.trim() })} className="h-8 flex-1 border-transparent bg-transparent px-2 hover:border-border focus:border-border" />
              {x.kind === "other" ? (
                <>
                  <label className="flex items-center gap-2 text-[11px] text-muted-foreground" title={t("timeAdmin.billableStatHint")}>
                    <Switch checked={x.billable} onCheckedChange={(v) => patchTime.mutate({ id: x.id, billable: v })} aria-label={t("timeAdmin.billableStat")} />
                    <span className={cn("w-24", x.billable ? "text-emerald-300" : "text-muted-foreground")}>{x.billable ? t("timeAdmin.billableYes") : t("timeAdmin.billableNo")}</span>
                  </label>
                  <Switch checked={x.active} onCheckedChange={(v) => patchTime.mutate({ id: x.id, active: v })} aria-label={t("timeAdmin.active")} />
                </>
              ) : (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground" title={t("timeAdmin.builtinHint")}>
                  <Lock className="size-3" /> {x.kind === "workday" ? t("timeAdmin.workdayKind") : x.kind === "bankpay" ? t("timeAdmin.bankpayKind") : t("timeAdmin.labourKind")}
                </span>
              )}
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            addTime.mutate();
          }}
        >
          <Input required placeholder={t("timeAdmin.newTime")} value={newTime} maxLength={80} onChange={(e) => setNewTime(e.target.value)} />
          <Button type="submit" variant="outline" disabled={addTime.isPending}>
            <Plus className="size-4" /> {t("timeAdmin.add")}
          </Button>
        </form>
      </section>

      <section className="space-y-3 rounded-2xl border bg-card/40 p-5">
        <div>
          <h3 className="flex items-center gap-2 font-semibold">
            <Wallet className="size-4 text-primary" /> {t("timeAdmin.expenseTitle")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("timeAdmin.expenseText")}</p>
        </div>
        <div className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1.4fr)_80px_90px_110px_50px] gap-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground md:grid">
          <span>{t("timeAdmin.name")}</span>
          <span>{t("timeAdmin.account")}</span>
          <span>{t("timeAdmin.unit")}</span>
          <span>{t("timeAdmin.rate")}</span>
          <span>{t("timeAdmin.billable")}</span>
          <span>{t("timeAdmin.active")}</span>
        </div>
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
          {(data?.expense ?? []).map((x) => (
            <li key={x.id} className={cn("grid items-center gap-2 px-3 py-2 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.4fr)_80px_90px_110px_50px]", !x.active && "opacity-50")}>
              <Input defaultValue={x.name} onBlur={(e) => e.target.value.trim() && e.target.value !== x.name && patchExpense.mutate({ id: x.id, name: e.target.value.trim() })} className="h-8" />
              <Select value={x.ledgerAccountId ?? "none"} onValueChange={(v) => patchExpense.mutate({ id: x.id, ledgerAccountId: v === "none" ? null : v })}>
                <SelectTrigger className={cn("h-8 w-full", !x.ledgerAccountId && "border-amber-500/50")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" className="max-h-72">
                  <SelectItem value="none">{t("timeAdmin.noAccount")}</SelectItem>
                  {expenseAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="font-mono text-xs">{a.number}</span> {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input defaultValue={x.unit ?? ""} placeholder="—" maxLength={20} onBlur={(e) => e.target.value !== (x.unit ?? "") && patchExpense.mutate({ id: x.id, unit: e.target.value.trim() || null })} className="h-8" />
              <Input
                defaultValue={x.unitPriceCents != null ? (x.unitPriceCents / 100).toFixed(2) : ""}
                placeholder="—"
                inputMode="decimal"
                disabled={!x.unit}
                onBlur={(e) => {
                  const v = e.target.value.trim() === "" ? null : Math.round(Number(e.target.value.replace(",", ".")) * 100);
                  if (v !== x.unitPriceCents) patchExpense.mutate({ id: x.id, unitPriceCents: v });
                }}
                className="h-8 font-mono"
              />
              <Switch checked={x.billable} onCheckedChange={(v) => patchExpense.mutate({ id: x.id, billable: v })} aria-label={t("timeAdmin.billable")} />
              <Switch checked={x.active} onCheckedChange={(v) => patchExpense.mutate({ id: x.id, active: v })} aria-label={t("timeAdmin.active")} />
            </li>
          ))}
        </ul>
        <form
          className="grid gap-2 rounded-xl border border-dashed p-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.4fr)_80px_90px_auto_auto]"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            addExpense.mutate();
          }}
        >
          <Input required placeholder={t("timeAdmin.newExpense")} value={nx.name} maxLength={80} onChange={(e) => setNx({ ...nx, name: e.target.value })} className="h-8" />
          <Select value={nx.ledgerAccountId || "none"} onValueChange={(v) => setNx({ ...nx, ledgerAccountId: v === "none" ? "" : v })}>
            <SelectTrigger className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-72">
              <SelectItem value="none">{t("timeAdmin.noAccount")}</SelectItem>
              {expenseAccounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <span className="font-mono text-xs">{a.number}</span> {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input placeholder={t("timeAdmin.unit")} value={nx.unit} maxLength={20} onChange={(e) => setNx({ ...nx, unit: e.target.value })} className="h-8" />
          <Input placeholder={t("timeAdmin.rate")} value={nx.rate} inputMode="decimal" disabled={!nx.unit} onChange={(e) => setNx({ ...nx, rate: e.target.value })} className="h-8 font-mono" />
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={nx.billable} onCheckedChange={(v) => setNx({ ...nx, billable: v })} /> {t("timeAdmin.billable")}
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={addExpense.isPending}>
            <Plus className="size-4" /> {t("timeAdmin.add")}
          </Button>
        </form>
        <p className="text-[11px] text-muted-foreground">{t("timeAdmin.accountHint")}</p>
      </section>
    </div>
  );
}
