import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link2, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./sections";

type Vendor = { id: string; name: string; email: string | null; phone: string | null; notes: string | null; active: boolean; quickbooksId: string | null };
type QbVendor = { id: string; name: string; email: string | null; phone: string | null };
const KEY = ["admin", "vendors"];

/**
 * Admin › PSA › Fournisseurs: the company's vendors. They are not synced with QuickBooks: each one is mapped
 * by hand to a QuickBooks vendor, or not mapped at all.
 */
export function VendorsSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data = [], isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<Vendor[]>("/admin/vendors") });
  const qbq = useQuery({ queryKey: [...KEY, "quickbooks"], queryFn: () => api.get<QbVendor[]>("/admin/vendors/quickbooks/list"), retry: false, staleTime: 60_000 });
  const qbVendors = qbq.data ?? [];
  const [f, setF] = useState({ name: "", email: "", phone: "" });
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY, exact: true });
  const fail = (e: unknown) => toast.error(e instanceof ApiError && e.code === "quickbooks_vendor_taken" ? t("vendors.taken", { name: e.fields?.[0]?.message ?? "" }) : t("common.error"));
  const add = useMutation({
    mutationFn: () => api.post("/admin/vendors", { name: f.name.trim(), email: f.email.trim(), phone: f.phone.trim() }),
    onSuccess: () => {
      setF({ name: "", email: "", phone: "" });
      refresh();
    },
    onError: fail,
  });
  const patch = useMutation({ mutationFn: (p: { id: string; body: Record<string, unknown> }) => api.patch(`/admin/vendors/${p.id}`, p.body), onSuccess: refresh, onError: fail });
  const map = useMutation({ mutationFn: (p: { id: string; quickbooksId: string | null }) => api.put(`/admin/vendors/${p.id}/quickbooks`, { quickbooksId: p.quickbooksId }), onSuccess: refresh, onError: fail });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/admin/vendors/${id}`), onSuccess: refresh, onError: fail });
  const taken = new Set(data.map((v) => v.quickbooksId).filter(Boolean));
  return (
    <div>
      <SectionHeader title={t("vendors.title")} subtitle={t("vendors.subtitle")} />
      <section className="mb-8 space-y-4 rounded-2xl border bg-card/60 p-4">
        {qbq.isError && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{t("vendors.qbUnavailable")}</p>}
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
          {isLoading && (
            <li className="p-4">
              <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
            </li>
          )}
          {!isLoading && data.length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">{t("vendors.none")}</li>}
          {data.map((v) => (
            <li key={v.id} className={cn("grid gap-2 px-3 py-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] md:items-center", !v.active && "opacity-60")}>
              <Input defaultValue={v.name} maxLength={200} className="h-8 text-sm" onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== v.name && patch.mutate({ id: v.id, body: { name: e.target.value.trim() } })} aria-label={t("vendors.name")} />
              <Input defaultValue={v.email ?? ""} maxLength={200} placeholder={t("vendors.email")} className="h-8 text-sm" onBlur={(e) => e.target.value.trim() !== (v.email ?? "") && patch.mutate({ id: v.id, body: { email: e.target.value.trim() } })} aria-label={t("vendors.email")} />
              <Input defaultValue={v.phone ?? ""} maxLength={60} placeholder={t("vendors.phone")} className="h-8 text-sm" onBlur={(e) => e.target.value.trim() !== (v.phone ?? "") && patch.mutate({ id: v.id, body: { phone: e.target.value.trim() } })} aria-label={t("vendors.phone")} />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Link2 className="size-3.5 shrink-0" />
                <select
                  value={v.quickbooksId ?? ""}
                  disabled={map.isPending || (qbq.isError && !v.quickbooksId)}
                  onChange={(e) => map.mutate({ id: v.id, quickbooksId: e.target.value || null })}
                  className="h-8 w-full min-w-0 rounded-md border bg-transparent px-2 text-xs outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40 disabled:opacity-60"
                  aria-label={t("vendors.qbVendor")}
                >
                  <option value="">{t("vendors.notMapped")}</option>
                  {v.quickbooksId && !qbVendors.some((x) => x.id === v.quickbooksId) && <option value={v.quickbooksId}>{`QuickBooks #${v.quickbooksId}`}</option>}
                  {qbVendors.map((x) => (
                    <option key={x.id} value={x.id} disabled={taken.has(x.id) && x.id !== v.quickbooksId}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
              <Switch checked={v.active} onCheckedChange={(on) => patch.mutate({ id: v.id, body: { active: on } })} aria-label={t("vendors.active")} />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 text-muted-foreground hover:text-destructive"
                onClick={() => void confirm({ title: t("vendors.deleteTitle", { name: v.name }), description: t("vendors.deleteText"), confirmLabel: t("vendors.delete"), destructive: true }).then((ok) => ok && remove.mutate(v.id))}
                aria-label={t("vendors.delete")}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="grid gap-2 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (f.name.trim()) add.mutate();
          }}
        >
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("vendors.name")}</span>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={200} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("vendors.email")}</span>
            <Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={200} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("vendors.phone")}</span>
            <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={60} />
          </label>
          <Button type="submit" disabled={add.isPending || !f.name.trim()} className="bg-grad-gold font-semibold text-[#1a1204]">
            {add.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {t("vendors.add")}
          </Button>
        </form>
        <p className="text-[11px] text-muted-foreground">{t("vendors.hint")}</p>
      </section>
    </div>
  );
}
