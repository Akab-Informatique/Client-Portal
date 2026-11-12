import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError } from "@/lib/api";

type Relation = "parent" | "grandparent" | "ancestor" | "child" | "grandchild" | "descendant";
type Grants = {
  home: { clientId: string; clientName: string | null; roleId: string | null; roleName: string | null };
  grants: { clientId: string; clientName: string; roleId: string; roleName: string }[];
  candidates: { id: string; name: string; relation: Relation; roles: { id: string; name: string }[] }[];
};
type Row = { clientId: string; roleId: string | null };

const ERRORS = ["company_not_in_chain", "invalid_role", "is_home_company"] as const;

/**
 * A client user's access to other companies of their chain (parent / children), each with the role that applies
 * there. Shown in the user sheet of a client user, for people with admin.clients.
 */
export function ClientGrants({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const key = ["admin", "users", userId, "grants"];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<Grants>(`/admin/users/${userId}/grants`) });

  const initial = useMemo<Row[]>(() => (data?.grants ?? []).map((g) => ({ clientId: g.clientId, roleId: g.roleId })), [data]);
  const [rows, setRows] = useState<Row[]>(initial);
  const [pick, setPick] = useState<string>("");
  useEffect(() => setRows(initial), [initial]);

  const sig = (list: Row[]) =>
    list
      .map((r) => `${r.clientId}:${r.roleId ?? ""}`)
      .sort()
      .join("|");
  const changed = sig(rows) !== sig(initial);
  const ready = rows.every((r) => r.roleId);

  const save = useMutation({
    mutationFn: () =>
      api.put<Grants>(
        `/admin/users/${userId}/grants`,
        { grants: rows.map((r) => ({ clientId: r.clientId, roleId: r.roleId })) },
      ),
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      toast.success(t("selfManaged.client.grants.saved"));
    },
    onError: (e) => {
      const code = e instanceof ApiError ? e.code : "";
      const known = (ERRORS as readonly string[]).includes(code);
      toast.error(known ? t(`selfManaged.client.grants.errors.${code}`) : t("selfManaged.client.grants.errors.generic"));
    },
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  const candidate = (id: string) => data.candidates.find((c) => c.id === id);
  const addable = data.candidates.filter((c) => c.id !== data.home.clientId && !rows.some((r) => r.clientId === c.id));
  const relationLabel = (r: Relation) => t(`selfManaged.client.grants.relation.${r}`);

  function add() {
    const c = candidate(pick);
    if (!c) return;
    setRows((list) => [...list, { clientId: c.id, roleId: c.roles[0]?.id ?? null }]);
    setPick("");
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="font-display text-sm font-semibold">{t("selfManaged.client.grants.title")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("selfManaged.client.grants.text")}</p>
      </div>

      <div className="flex items-center gap-3 rounded-xl border bg-background/30 p-3">
        <Building2 className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{data.home.clientName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {t("selfManaged.client.grants.home")}
            {data.home.roleName ? ` · ${data.home.roleName}` : ""}
          </p>
        </div>
      </div>

      {rows.length === 0 && <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">{t("selfManaged.client.grants.empty")}</p>}

      <ul className="space-y-2">
        {rows.map((r) => {
          const c = candidate(r.clientId);
          const grant = data.grants.find((g) => g.clientId === r.clientId);
          const name = c?.name ?? grant?.clientName ?? "";
          return (
            <li key={r.clientId} className="flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{name}</p>
                {c && <p className="truncate text-xs text-muted-foreground">{relationLabel(c.relation)}</p>}
              </div>
              <div className="w-full sm:w-56">
                <Select
                  value={r.roleId ?? "none"}
                  onValueChange={(v) => setRows((list) => list.map((x) => (x.clientId === r.clientId ? { ...x, roleId: v === "none" ? null : v } : x)))}
                >
                  <SelectTrigger className="w-full" aria-label={`${t("selfManaged.client.grants.role")} — ${name}`}>
                    <SelectValue placeholder={t("selfManaged.client.grants.pickRole")} />
                  </SelectTrigger>
                  <SelectContent>
                    {!r.roleId && <SelectItem value="none">{t("selfManaged.client.grants.noRole")}</SelectItem>}
                    {(c?.roles ?? []).map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        {role.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${t("selfManaged.client.grants.remove")} — ${name}`}
                onClick={() => setRows((list) => list.filter((x) => x.clientId !== r.clientId))}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          );
        })}
      </ul>

      {addable.length > 0 ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="grant-company">{t("selfManaged.client.grants.add")}</Label>
            <Select value={pick || "none"} onValueChange={(v) => setPick(v === "none" ? "" : v)}>
              <SelectTrigger id="grant-company" className="w-full">
                <SelectValue placeholder={t("selfManaged.client.grants.pick")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("selfManaged.client.grants.pick")}</SelectItem>
                {addable.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} — {relationLabel(c.relation)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" onClick={add} disabled={!pick}>
            <Plus className="size-4" /> {t("selfManaged.client.grants.add")}
          </Button>
        </div>
      ) : (
        rows.length === 0 && <p className="text-xs text-muted-foreground">{t("selfManaged.client.grants.noCandidates")}</p>
      )}

      <div className="flex justify-end border-t pt-4">
        <Button onClick={() => save.mutate()} disabled={!changed || !ready || save.isPending}>
          {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("selfManaged.client.grants.save")}
        </Button>
      </div>
    </div>
  );
}
