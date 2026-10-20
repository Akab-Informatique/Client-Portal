import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { SectionHeader } from "./sections";

type Kind = "recurring" | "hourly" | "banked" | "fixed";
const KINDS: Kind[] = ["recurring", "hourly", "banked", "fixed"];
type ContractType = { key: string; name: string; kind: Kind; active: boolean; position: number; contracts: number };
const KEY = ["admin", "contract-types"];

/**
 * Admin › Types de contrats: the kinds of contract a client can have. Each type has a name and one of four
 * ways to bill: recurring service, hourly, banked hours or fixed price.
 */
export function ContractTypesSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data = [], isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<ContractType[]>("/admin/contract-types") });
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("hourly");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: ["crm", "contract-types"] });
  };
  const fail = (e: unknown) => toast.error(e instanceof ApiError && e.code === "type_in_use" ? t("contractTypes.inUse") : t("common.error"));
  const add = useMutation({
    mutationFn: () => api.post("/admin/contract-types", { name: name.trim(), kind }),
    onSuccess: () => {
      setName("");
      refresh();
    },
    onError: fail,
  });
  const patch = useMutation({ mutationFn: (p: { key: string; body: Record<string, unknown> }) => api.patch(`/admin/contract-types/${p.key}`, p.body), onSuccess: refresh, onError: fail });
  const move = useMutation({ mutationFn: (p: { key: string; direction: "up" | "down" }) => api.post(`/admin/contract-types/${p.key}/move`, { direction: p.direction }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (key: string) => api.del(`/admin/contract-types/${key}`), onSuccess: refresh, onError: fail });
  return (
    <div>
      <SectionHeader title={t("contractTypes.title")} subtitle={t("contractTypes.subtitle")} />
      <section className="mb-8 rounded-2xl border bg-card/60 p-4">
        <ul className="mb-4 divide-y divide-border/60 overflow-hidden rounded-xl border">
          {isLoading && (
            <li className="p-4">
              <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
            </li>
          )}
          {data.map((x, i) => (
            <li key={x.key} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="flex flex-col">
                <button type="button" className="text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={i === 0 || move.isPending} onClick={() => move.mutate({ key: x.key, direction: "up" })} aria-label={t("contractTypes.up")}>
                  <ArrowUp className="size-3.5" />
                </button>
                <button type="button" className="text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={i === data.length - 1 || move.isPending} onClick={() => move.mutate({ key: x.key, direction: "down" })} aria-label={t("contractTypes.down")}>
                  <ArrowDown className="size-3.5" />
                </button>
              </div>
              <Input
                defaultValue={x.name}
                maxLength={60}
                className="h-8 min-w-48 flex-1 text-sm"
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== x.name && patch.mutate({ key: x.key, body: { name: e.target.value.trim() } })}
              />
              <span className="rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground">{t(`contractTypes.kind.${x.kind}`)}</span>
              <span className="w-28 text-right text-xs text-muted-foreground">{t("contractTypes.contracts", { count: x.contracts })}</span>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={x.active} onCheckedChange={(v) => patch.mutate({ key: x.key, body: { active: v } })} /> {t("contractTypes.active")}
              </label>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 text-muted-foreground hover:text-destructive"
                disabled={x.contracts > 0 || remove.isPending}
                title={x.contracts > 0 ? t("contractTypes.inUse") : t("contractTypes.delete")}
                onClick={() => void confirm({ title: t("contractTypes.deleteTitle", { name: x.name }), description: t("contractTypes.deleteText"), confirmLabel: t("contractTypes.delete"), destructive: true }).then((ok) => ok && remove.mutate(x.key))}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (name.trim()) add.mutate();
          }}
        >
          <label className="min-w-48 flex-1 space-y-1 text-xs">
            <span className="text-muted-foreground">{t("contractTypes.name")}</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t("contractTypes.namePlaceholder")} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("contractTypes.kindLabel")}</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className="h-9 w-56 rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40">
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`contractTypes.kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={add.isPending || !name.trim()} className="bg-grad-gold font-semibold text-[#1a1204]">
            {add.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {t("contractTypes.add")}
          </Button>
        </form>
        <ul className="mt-4 space-y-1 text-[11px] text-muted-foreground">
          {KINDS.map((k) => (
            <li key={k}>
              <span className="font-medium text-foreground">{t(`contractTypes.kind.${k}`)}</span> — {t(`contractTypes.help.${k}`)}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
