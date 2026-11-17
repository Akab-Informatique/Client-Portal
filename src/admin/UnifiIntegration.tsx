import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Network } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type View = { enabled: boolean; hasKey: boolean; ready: boolean; lastTest: { ok: boolean; at: string; error?: string; hosts?: number } | null };
const KEY = ["admin", "unifi"];

/** The state of the integration (the same rules as its badge) */
export function useUnifiState(): string | null {
  const { data } = useQuery({ queryKey: KEY, queryFn: () => api.get<View>("/admin/unifi") });
  if (!data) return null;
  if (data.ready) return data.lastTest && !data.lastTest.ok ? "error" : "connected";
  return data.hasKey ? "disabled" : "notConfigured";
}

export function UnifiStatus() {
  const { t } = useTranslation();
  const state = useUnifiState();
  if (!state) return null;
  return (
    <Badge variant="outline" className={cn("gap-1.5", state === "connected" ? "border-emerald-500/40 text-emerald-400" : state === "error" ? "border-red-500/40 text-red-400" : "text-muted-foreground")}>
      <span className="size-1.5 rounded-full bg-current" />
      {t(`integrations.status.${state}`)}
    </Badge>
  );
}

/** Admin > Integrations > UniFi: the API key (sealed, never shown again), on / off and a test. Read only. */
export function UnifiPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: s, isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<View>("/admin/unifi") });
  const [key, setKey] = useState("");
  const err = (e: unknown) => toast.error(e instanceof ApiError ? t(`unifi.errors.${e.code}`, { defaultValue: t("unifi.errors.generic") }) : t("common.error"));
  const save = useMutation({
    mutationFn: (p: { enabled: boolean; apiKey?: string }) => api.put<View>("/admin/unifi", p),
    onSuccess: (next) => {
      qc.setQueryData(KEY, next);
      setKey("");
      toast.success(t("common.saved"));
    },
    onError: err,
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; hosts?: number; error?: string }>("/admin/unifi/test"),
    onSuccess: (r) => {
      if (r.ok) toast.success(t("unifi.admin.testOk", { count: r.hosts ?? 0 }));
      else toast.error(t(`unifi.errors.${r.error}`, { defaultValue: t("unifi.errors.generic") }));
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: err,
  });
  if (isLoading || !s) return <Skeleton className="h-48 rounded-2xl" />;
  return (
    <section className="overflow-hidden rounded-2xl border bg-card/80">
      <div className="flex flex-wrap items-center gap-4 border-b px-6 py-5">
        <span className="flex size-11 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204]">
          <Network className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold">{t("unifi.admin.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("unifi.admin.subtitle")}</p>
        </div>
        <label className="flex items-center gap-3 text-sm font-medium">
          {t("integrations.enabled")}
          <Switch checked={s.enabled} disabled={save.isPending || (!s.hasKey && !key.trim())} onCheckedChange={(v) => save.mutate({ enabled: v, ...(key.trim() ? { apiKey: key.trim() } : {}) })} />
        </label>
      </div>
      <form
        className="space-y-4 px-6 py-6"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (key.trim()) save.mutate({ enabled: s.enabled, apiKey: key.trim() });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="unifi-key">{t("unifi.admin.key")}</Label>
          <Input id="unifi-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t("unifi.admin.keyPlaceholder")} className="font-mono text-xs" />
          <p className="text-xs text-muted-foreground">{s.hasKey ? t("unifi.admin.keySaved") : t("unifi.admin.keyHelp")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!key.trim() || save.isPending}>
            {t("unifi.admin.save")}
          </Button>
          <Button type="button" variant="outline" disabled={!s.hasKey || test.isPending} onClick={() => test.mutate()}>
            {test.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            {t("unifi.admin.test")}
          </Button>
          {s.lastTest && (
            <span className={cn("text-xs", s.lastTest.ok ? "text-emerald-400" : "text-red-400")}>
              {s.lastTest.ok ? t("unifi.admin.testOk", { count: s.lastTest.hosts ?? 0 }) : t(`unifi.errors.${s.lastTest.error}`, { defaultValue: t("unifi.errors.generic") })} · {t("unifi.admin.lastTest", { when: relativeTime(s.lastTest.at) })}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
