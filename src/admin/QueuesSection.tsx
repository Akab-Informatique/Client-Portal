import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, BellRing, Check, Info, Loader2, Plus, Star, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./sections";

type Queue = { key: string; name: string; alerts: boolean; isDefault: boolean; position: number; openTickets: number };
const KEY = ["admin", "queues"];

/**
 * Admin › Files d'attente: the portal's own ticket queues (Support, Alertes
 * and Projets to start). Not tied to Autotask: what is set here is only in
 * the portal.
 */
export function QueuesSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data = [], isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<Queue[]>("/admin/queues") });
  const [name, setName] = useState("");
  const [alerts, setAlerts] = useState(false);
  // what the tickets pages show must follow
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: ["tickets"] });
    void qc.invalidateQueries({ queryKey: ["meetings"] });
  };
  const fail = (e: unknown) => toast.error(e instanceof ApiError ? t(`queues.errors.${e.code}`, { defaultValue: t("common.error") }) : t("common.error"));
  const add = useMutation({
    mutationFn: () => api.post("/admin/queues", { name: name.trim(), alerts }),
    onSuccess: () => {
      setName("");
      setAlerts(false);
      refresh();
      toast.success(t("queues.added"));
    },
    onError: fail,
  });
  const change = useMutation({ mutationFn: (v: { key: string; patch: Record<string, unknown> }) => api.patch(`/admin/queues/${v.key}`, v.patch), onSuccess: refresh, onError: fail });
  const move = useMutation({ mutationFn: (v: { key: string; direction: "up" | "down" }) => api.post(`/admin/queues/${v.key}/move`, { direction: v.direction }), onSuccess: refresh, onError: fail });
  const remove = useMutation({
    mutationFn: (key: string) => api.del(`/admin/queues/${key}`),
    onSuccess: () => {
      refresh();
      toast.success(t("queues.deleted"));
    },
    onError: fail,
  });

  return (
    <div>
      <SectionHeader title={t("queues.title")} subtitle={t("queues.subtitle")} />
      <p className="mb-5 flex items-start gap-2 rounded-xl border bg-card/60 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0 text-primary" /> {t("queues.notAutotask")}
      </p>

      <form
        className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border bg-card/80 p-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (name.trim()) add.mutate();
        }}
      >
        <Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={t("queues.newPlaceholder")} className="max-w-64" aria-label={t("queues.newPlaceholder")} />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={alerts} onCheckedChange={setAlerts} /> {t("queues.alerts")}
        </label>
        <Button type="submit" disabled={!name.trim() || add.isPending}>
          {add.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {t("queues.add")}
        </Button>
      </form>

      {isLoading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
      <ul className="space-y-2">
        {data.map((q, i) => (
          <Row
            key={q.key}
            q={q}
            first={i === 0}
            last={i === data.length - 1}
            busy={change.isPending || move.isPending || remove.isPending}
            onRename={(n) => change.mutate({ key: q.key, patch: { name: n } })}
            onAlerts={(v) => change.mutate({ key: q.key, patch: { alerts: v } })}
            onDefault={() => change.mutate({ key: q.key, patch: { isDefault: true } })}
            onMove={(direction) => move.mutate({ key: q.key, direction })}
            onDelete={() => remove.mutate(q.key)}
          />
        ))}
      </ul>
    </div>
  );
}

function Row({
  q,
  first,
  last,
  busy,
  onRename,
  onAlerts,
  onDefault,
  onMove,
  onDelete,
}: {
  q: Queue;
  first: boolean;
  last: boolean;
  busy: boolean;
  onRename: (name: string) => void;
  onAlerts: (on: boolean) => void;
  onDefault: () => void;
  onMove: (d: "up" | "down") => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [name, setName] = useState(q.name);
  useEffect(() => setName(q.name), [q.name]);
  const save = () => {
    const n = name.trim();
    if (!n) setName(q.name);
    else if (n !== q.name) onRename(n);
  };
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card/80 p-3">
      <div className="flex flex-col">
        <button type="button" disabled={first || busy} onClick={() => onMove("up")} className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label={t("queues.up")}>
          <ArrowUp className="size-4" />
        </button>
        <button type="button" disabled={last || busy} onClick={() => onMove("down")} className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label={t("queues.down")}>
          <ArrowDown className="size-4" />
        </button>
      </div>
      <Input
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setName(q.name);
        }}
        className="h-9 w-56 font-medium"
        aria-label={t("queues.name")}
      />
      {q.isDefault && (
        <Badge variant="outline" className="gap-1 border-[color:var(--gold)]/50 text-primary">
          <Star className="size-3" /> {t("queues.default")}
        </Badge>
      )}
      <label className={cn("flex items-center gap-2 text-sm", q.isDefault ? "text-muted-foreground/60" : "text-muted-foreground")} title={q.isDefault ? t("queues.defaultNotAlerts") : t("queues.alertsHint")}>
        <Switch checked={q.alerts} disabled={q.isDefault || busy} onCheckedChange={onAlerts} />
        <BellRing className="size-3.5" /> {t("queues.alerts")}
      </label>
      <span className="ml-auto text-xs text-muted-foreground">{t("queues.open", { count: q.openTickets })}</span>
      {!q.isDefault && (
        <Button type="button" variant="outline" size="sm" disabled={q.alerts || busy} onClick={onDefault} title={q.alerts ? t("queues.defaultNotAlerts") : undefined}>
          <Check className="size-3.5" /> {t("queues.makeDefault")}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={q.isDefault || busy}
        className="text-muted-foreground hover:text-destructive"
        aria-label={t("common.delete")}
        title={q.isDefault ? t("queues.errors.queue_is_default") : t("common.delete")}
        onClick={() => void confirm({ title: t("queues.deleteTitle", { name: q.name }), description: t("queues.deleteText", { count: q.openTickets }), destructive: true }).then((ok) => ok && onDelete())}
      >
        <Trash2 className="size-4" />
      </Button>
    </li>
  );
}
