import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { ProjBillingMode } from "./shared";

/** What the billing fields hold while typed (strings, as the inputs give them) */
export type BillingValue = { mode: ProjBillingMode; contractId: string; rate: string; price: string; expires: string };

export const emptyBilling: BillingValue = { mode: "hourly", contractId: "", rate: "", price: "", expires: "" };

const num = (s: string): number | undefined => {
  const n = Number(s.replace(",", ".").trim());
  return s.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** The fields POST / PATCH /api/proj take for this billing */
export function billingPayload(v: BillingValue): Record<string, unknown> {
  const body: Record<string, unknown> = { billingMode: v.mode };
  if (v.mode === "contract") body.contractId = v.contractId || null;
  if (v.mode === "special" || v.mode === "bank") body.hourlyRate = num(v.rate) ?? null;
  if (v.mode === "fixed") body.fixedPrice = num(v.price) ?? null;
  if (v.mode === "bank") body.bankExpiresOn = v.expires || null;
  return body;
}

const fieldCls = "h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-violet-500/40 disabled:opacity-60";
const labelText = "block text-[11px] font-medium uppercase tracking-wide text-muted-foreground";
export const MODES: ProjBillingMode[] = ["hourly", "contract", "special", "fixed", "bank"];

/** How the project's time is billed: the mode and what it needs (a contract, a rate, a price, hours and an expiry day) */
export function BillingFields({ value, onChange, clientId, disabled }: { value: BillingValue; onChange: (v: BillingValue) => void; clientId: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const set = (p: Partial<BillingValue>) => onChange({ ...value, ...p });
  const contracts = useQuery({
    queryKey: ["proj", "client-contracts", clientId],
    queryFn: () => api.get<{ id: string; name: string; hourlyRate: number | null }[]>(`/proj/client-contracts/${clientId}`),
    enabled: value.mode === "contract" && Boolean(clientId),
    staleTime: 30_000,
  });
  return (
    <fieldset className="space-y-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-3" disabled={disabled}>
      <legend className="px-1 text-xs font-semibold text-violet-200">{t("projBill.title")}</legend>
      <select className={fieldCls} value={value.mode} aria-label={t("projBill.title")} onChange={(e) => set({ mode: e.target.value as ProjBillingMode })}>
        {MODES.map((m) => (
          <option key={m} value={m}>
            {t(`projBill.mode.${m}`)}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-muted-foreground">{t(`projBill.hint.${value.mode}`)}</p>

      {value.mode === "contract" && (
        <label className="block space-y-1">
          <span className={labelText}>{t("projBill.contract")}</span>
          {!clientId ? (
            <p className="text-xs text-amber-300">{t("projBill.needClient")}</p>
          ) : (
            <select className={fieldCls} value={value.contractId} onChange={(e) => set({ contractId: e.target.value })}>
              <option value="">{t("projBill.contractPick")}</option>
              {(contracts.data ?? []).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                  {k.hourlyRate != null ? ` — ${k.hourlyRate.toLocaleString("fr-CA", { style: "currency", currency: "CAD" })}/h` : ""}
                </option>
              ))}
            </select>
          )}
          {clientId && contracts.data && contracts.data.length === 0 && <p className="text-xs text-amber-300">{t("projBill.contractNone")}</p>}
        </label>
      )}

      {(value.mode === "special" || value.mode === "bank") && (
        <label className="block space-y-1">
          <span className={labelText}>{t(value.mode === "bank" ? "projBill.bankRate" : "projBill.rate")}</span>
          <Input type="number" inputMode="decimal" min={0} step={0.01} value={value.rate} onChange={(e) => set({ rate: e.target.value })} />
        </label>
      )}
      {value.mode === "fixed" && (
        <label className="block space-y-1">
          <span className={labelText}>{t("projBill.price")}</span>
          <Input type="number" inputMode="decimal" min={0} step={0.01} value={value.price} onChange={(e) => set({ price: e.target.value })} />
        </label>
      )}
      {value.mode === "bank" && (
        <label className="block space-y-1">
          <span className={labelText}>{t("projBill.expires")}</span>
          <input type="date" className={fieldCls} value={value.expires} onChange={(e) => set({ expires: e.target.value })} />
        </label>
      )}
    </fieldset>
  );
}
