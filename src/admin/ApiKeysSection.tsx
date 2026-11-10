import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MODULES } from "@shared/permissions";
import { SectionHeader } from "./sections";

type Key = { id: string; name: string; prefix: string; permissions: string[]; write: boolean; expiresAt: string | null; lastUsedAt: string | null; lastIp: string | null; revokedAt: string | null; createdAt: string };
const KEY = ["admin", "api-keys"];

/** Admin › Clés d'API: keys (Bearer) for outside tools. Shown once; read only unless write is ticked. */
export function ApiKeysSection() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === "en" ? "en" : "fr";
  const qc = useQueryClient();
  const confirm = useConfirm();
  const keys = useQuery({ queryKey: KEY, queryFn: () => api.get<Key[]>("/admin/api-keys") });
  const rights = useQuery({ queryKey: [...KEY, "rights"], queryFn: () => api.get<string[]>("/admin/api-keys/rights") });
  const allowed = new Set(rights.data ?? []);
  const [name, setName] = useState("");
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState("90");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY, exact: true });
  const create = useMutation({
    mutationFn: () => api.post<{ key: string; name: string }>("/admin/api-keys", { name: name.trim(), permissions: [...picked], write, expiresInDays: days ? Number(days) : null }),
    onSuccess: (r) => {
      setFresh({ name: r.name, key: r.key });
      setName("");
      setPicked(new Set());
      setWrite(false);
      refresh();
    },
    onError: () => toast.error(t("common.error")),
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/admin/api-keys/${id}`), onSuccess: refresh, onError: () => toast.error(t("common.error")) });
  const toggle = (k: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const mods = MODULES.map((m) => ({ ...m, permissions: m.permissions.filter((p) => allowed.has(p.key)) })).filter((m) => m.permissions.length);
  const viewKeys = [...allowed].filter((k) => k.endsWith(".view"));
  const copy = (s: string) => void navigator.clipboard.writeText(s).then(() => toast.success(t("apiKeys.copied")));
  return (
    <div>
      <SectionHeader title={t("apiKeys.title")} subtitle={t("apiKeys.subtitle")} />
      {fresh && (
        <section className="mb-6 space-y-2 rounded-2xl border border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 p-4">
          <p className="text-sm font-medium">{t("apiKeys.freshTitle", { name: fresh.name })}</p>
          <p className="text-xs text-muted-foreground">{t("apiKeys.freshText")}</p>
          <div className="flex gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg border bg-background/60 px-3 py-2 text-xs">{fresh.key}</code>
            <Button type="button" variant="outline" onClick={() => copy(fresh.key)}>
              <Copy className="size-4" /> {t("apiKeys.copy")}
            </Button>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setFresh(null)}>
            {t("apiKeys.done")}
          </Button>
        </section>
      )}
      <section className="mb-8 space-y-4 rounded-2xl border bg-card/60 p-4">
        <h3 className="flex items-center gap-2 font-semibold">
          <KeyRound className="size-4" /> {t("apiKeys.new")}
        </h3>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem]">
          <Input value={name} maxLength={80} placeholder={t("apiKeys.namePh")} onChange={(e) => setName(e.target.value)} aria-label={t("apiKeys.name")} />
          <Input value={days} inputMode="numeric" placeholder={t("apiKeys.days")} onChange={(e) => setDays(e.target.value.replace(/\D/g, "").slice(0, 3))} aria-label={t("apiKeys.days")} />
        </div>
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={write} onCheckedChange={setWrite} />
          <span>{t("apiKeys.write")}</span>
        </label>
        {write && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{t("apiKeys.writeWarn")}</p>}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t("apiKeys.rights", { n: picked.size })}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => setPicked(new Set(viewKeys))}>
            {t("apiKeys.allView")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
            {t("apiKeys.clear")}
          </Button>
        </div>
        <div className="grid max-h-80 gap-3 overflow-y-auto rounded-xl border p-3 md:grid-cols-2">
          {mods.map((m) => (
            <fieldset key={m.key} className="space-y-1">
              <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{m.label[lang]}</legend>
              {m.permissions.map((p) => (
                <label key={p.key} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={picked.has(p.key)} onChange={() => toggle(p.key)} />
                  {p.label[lang]}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        <Button type="button" disabled={!name.trim() || picked.size === 0 || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {t("apiKeys.create")}
        </Button>
      </section>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
        {keys.isLoading && (
          <li className="p-4">
            <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
          </li>
        )}
        {!keys.isLoading && (keys.data ?? []).length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">{t("apiKeys.none")}</li>}
        {(keys.data ?? []).map((k) => {
          const expired = k.expiresAt && new Date(k.expiresAt).getTime() < Date.now();
          return (
            <li key={k.id} className={cn("flex flex-wrap items-center gap-3 px-3 py-3", (k.revokedAt || expired) && "opacity-50")}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {k.name} <code className="text-xs text-muted-foreground">{k.prefix}…</code>
                </p>
                <p className="text-xs text-muted-foreground">
                  {k.write ? t("apiKeys.modeWrite") : t("apiKeys.modeRead")} · {t("apiKeys.rights", { n: k.permissions.length })} ·{" "}
                  {k.lastUsedAt ? t("apiKeys.lastUsed", { when: dateTime(k.lastUsedAt) }) : t("apiKeys.never")}
                  {k.expiresAt ? ` · ${t(expired ? "apiKeys.expired" : "apiKeys.expires", { when: dateTime(k.expiresAt) })}` : ""}
                  {k.revokedAt ? ` · ${t("apiKeys.revoked")}` : ""}
                </p>
              </div>
              {!k.revokedAt && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("apiKeys.revoke")}
                  onClick={async () => (await confirm({ title: t("apiKeys.revokeTitle", { name: k.name }), description: t("apiKeys.revokeText"), confirmLabel: t("apiKeys.revoke"), destructive: true })) && revoke.mutate(k.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
