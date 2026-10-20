import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { CLASS_COLORS, classStyle } from "@/lib/clientClass";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./sections";

type Klass = { key: string; name: string; color: string; position: number; clients: number };
const KEY = ["admin", "client-classes"];

/** Admin › Classifications: how clients are classed (break & fix, MSP, bronze, silver, gold… and your own). */
export function ClassesSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data = [], isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<Klass[]>("/admin/client-classes") });
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>("slate");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: ["crm"] });
    void qc.invalidateQueries({ queryKey: ["tickets"] });
  };
  const fail = (e: unknown) => toast.error(e instanceof ApiError ? t(`classes.errors.${e.code}`, { defaultValue: t("common.error") }) : t("common.error"));
  const add = useMutation({
    mutationFn: () => api.post("/admin/client-classes", { name: name.trim(), color }),
    onSuccess: () => {
      setName("");
      refresh();
      toast.success(t("classes.added"));
    },
    onError: fail,
  });
  const change = useMutation({ mutationFn: (v: { key: string; patch: Record<string, unknown> }) => api.patch(`/admin/client-classes/${v.key}`, v.patch), onSuccess: refresh, onError: fail });
  const move = useMutation({ mutationFn: (v: { key: string; direction: "up" | "down" }) => api.post(`/admin/client-classes/${v.key}/move`, { direction: v.direction }), onSuccess: refresh, onError: fail });
  const remove = useMutation({
    mutationFn: (key: string) => api.del(`/admin/client-classes/${key}`),
    onSuccess: () => {
      refresh();
      toast.success(t("classes.deleted"));
    },
    onError: fail,
  });

  return (
    <div>
      <SectionHeader title={t("classes.title")} subtitle={t("classes.subtitle")} />
      <form
        className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border bg-card/80 p-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (name.trim()) add.mutate();
        }}
      >
        <Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={t("classes.newPlaceholder")} className="max-w-64" aria-label={t("classes.newPlaceholder")} />
        <Swatches value={color} onChange={setColor} />
        <Button type="submit" disabled={!name.trim() || add.isPending}>
          {add.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {t("classes.add")}
        </Button>
      </form>

      {isLoading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
      <ul className="space-y-2">
        {data.map((k, i) => (
          <Row
            key={k.key}
            k={k}
            first={i === 0}
            last={i === data.length - 1}
            busy={change.isPending || move.isPending || remove.isPending}
            onRename={(n) => change.mutate({ key: k.key, patch: { name: n } })}
            onColor={(c) => change.mutate({ key: k.key, patch: { color: c } })}
            onMove={(direction) => move.mutate({ key: k.key, direction })}
            onDelete={() => remove.mutate(k.key)}
          />
        ))}
      </ul>
    </div>
  );
}

function Swatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label={t("classes.color")}>
      {CLASS_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          title={t(`classes.colors.${c}`)}
          onClick={() => onChange(c)}
          className={cn("size-5 rounded-full ring-offset-2 ring-offset-background transition", classStyle(c).dot, value === c ? "ring-2 ring-foreground/70" : "opacity-60 hover:opacity-100")}
        />
      ))}
    </div>
  );
}

function Row({
  k,
  first,
  last,
  busy,
  onRename,
  onColor,
  onMove,
  onDelete,
}: {
  k: Klass;
  first: boolean;
  last: boolean;
  busy: boolean;
  onRename: (name: string) => void;
  onColor: (c: string) => void;
  onMove: (d: "up" | "down") => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [name, setName] = useState(k.name);
  useEffect(() => setName(k.name), [k.name]);
  const save = () => {
    const n = name.trim();
    if (!n) setName(k.name);
    else if (n !== k.name) onRename(n);
  };
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card/80 p-3">
      <div className="flex flex-col">
        <button type="button" disabled={first || busy} onClick={() => onMove("up")} className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label={t("classes.up")}>
          <ArrowUp className="size-4" />
        </button>
        <button type="button" disabled={last || busy} onClick={() => onMove("down")} className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label={t("classes.down")}>
          <ArrowDown className="size-4" />
        </button>
      </div>
      <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", classStyle(k.color).pill)}>{k.name}</span>
      <Input
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setName(k.name);
        }}
        className="h-9 w-52 font-medium"
        aria-label={t("classes.name")}
      />
      <Swatches value={k.color} onChange={onColor} />
      <span className="ml-auto text-xs text-muted-foreground">{t("classes.clients", { count: k.clients })}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={busy}
        className="text-muted-foreground hover:text-destructive"
        aria-label={t("common.delete")}
        onClick={() => void confirm({ title: t("classes.deleteTitle", { name: k.name }), description: t("classes.deleteText", { count: k.clients }), destructive: true }).then((ok) => ok && onDelete())}
      >
        <Trash2 className="size-4" />
      </Button>
    </li>
  );
}
