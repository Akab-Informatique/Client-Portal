import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ListTree, Lock, Pencil, Trash2, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";

/** A list of to-do tasks: shared with the team or personal (its owner's). Every task is on one. */
export type TaskList = { id: string; name: string; shared: boolean; ownerId: string | null; owner: string | null; mine: boolean; open: number };

export function useTaskLists() {
  return useQuery({ queryKey: ["pipeline", "lists"], queryFn: () => api.get<TaskList[]>("/pipeline/lists"), staleTime: 30_000 });
}

/** The list a new task starts on: the one last picked on this computer when it is still there, else the first shared one */
const KEY = "akab.pipeline.list";
export const rememberedList = (lists: TaskList[] | undefined): string => {
  let saved = "";
  try {
    saved = localStorage.getItem(KEY) ?? "";
  } catch {
    /* not kept */
  }
  return lists?.find((l) => l.id === saved)?.id ?? lists?.find((l) => l.shared)?.id ?? lists?.[0]?.id ?? "";
};
export const rememberList = (id: string) => {
  try {
    if (id) localStorage.setItem(KEY, id);
  } catch {
    /* not kept */
  }
};

export function listError(t: (k: string) => string, e: unknown): string {
  if (!(e instanceof ApiError) || !e.code) return t("common.error");
  const key = `pipeline.lists.errors.${e.code}`;
  const text = t(key);
  return text === key ? t("common.error") : text;
}

/** A small tag with the list a task is on (a lock for a personal list) */
export function ListBadge({ name, shared, className }: { name: string | null | undefined; shared?: boolean; className?: string }) {
  const { t } = useTranslation();
  if (!name) return null;
  return (
    <span title={t(shared === false ? "pipeline.lists.personal" : "pipeline.lists.shared")} className={cn("inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium", shared === false ? "border-violet-400/40 bg-violet-500/10 text-violet-200" : "border-sky-400/30 bg-sky-500/10 text-sky-200", className)}>
      {shared === false ? <Lock className="size-2.5 shrink-0" /> : <Users className="size-2.5 shrink-0" />}
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Pick a list (the shared ones, then one's own personal ones) */
export function ListSelect({ value, onChange, lists, all, disabled, className, label }: { value: string; onChange: (id: string) => void; lists: TaskList[] | undefined; all?: string; disabled?: boolean; className?: string; label?: string }) {
  const { t } = useTranslation();
  const shared = (lists ?? []).filter((l) => l.shared);
  const own = (lists ?? []).filter((l) => !l.shared);
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={label ?? t("pipeline.lists.label")} className={cn("h-9 rounded-md border bg-transparent px-2 text-sm", className)}>
      {all !== undefined && <option value="">{all}</option>}
      {shared.length > 0 && (
        <optgroup label={t("pipeline.lists.shared")}>
          {shared.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </optgroup>
      )}
      {own.length > 0 && (
        <optgroup label={t("pipeline.lists.personal")}>
          {own.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

/** Make, rename and delete lists (a list that still has tasks is not deleted) */
export function ManageLists({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useCan();
  const lists = useTaskLists();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["pipeline"] });
  const make = useMutation({
    mutationFn: () => api.post("/pipeline/lists", { name: name.trim(), shared }),
    onSuccess: () => {
      setName("");
      toast.success(t("pipeline.lists.created"));
      refresh();
    },
    onError: (e) => toast.error(listError(t, e)),
  });
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.patch(`/pipeline/lists/${v.id}`, { name: v.name.trim() }),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
    onError: (e) => toast.error(listError(t, e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/pipeline/lists/${id}`),
    onSuccess: () => {
      toast.success(t("pipeline.lists.deleted"));
      refresh();
    },
    onError: (e) => toast.error(listError(t, e)),
  });
  const edit = can("pipeline.edit");
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListTree className="size-4 text-primary" /> {t("pipeline.lists.title")}
          </DialogTitle>
          <DialogDescription>{t("pipeline.lists.text")}</DialogDescription>
        </DialogHeader>
        <ul className="divide-y divide-border/50 rounded-xl border">
          {(lists.data ?? []).map((l) => (
            <li key={l.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              {l.shared ? <Users className="size-4 shrink-0 text-sky-300" /> : <Lock className="size-4 shrink-0 text-violet-300" />}
              {editing?.id === l.id ? (
                <>
                  <Input autoFocus value={editing.name} maxLength={80} onChange={(e) => setEditing({ id: l.id, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && editing.name.trim() && rename.mutate(editing)} className="h-8 flex-1" />
                  <button type="button" onClick={() => editing.name.trim() && rename.mutate(editing)} className="rounded p-1 text-emerald-300 hover:bg-foreground/10" aria-label={t("pipeline.lists.rename")}>
                    <Check className="size-4" />
                  </button>
                  <button type="button" onClick={() => setEditing(null)} className="rounded p-1 text-muted-foreground hover:bg-foreground/10" aria-label="×">
                    <X className="size-4" />
                  </button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate font-medium">{l.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{t("pipeline.lists.open", { count: l.open })}</span>
                  {edit && (l.mine || can("pipeline.manage")) && (
                    <>
                      <button type="button" onClick={() => setEditing({ id: l.id, name: l.name })} className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground" aria-label={t("pipeline.lists.rename")} title={t("pipeline.lists.rename")}>
                        <Pencil className="size-3.5" />
                      </button>
                      <button type="button" onClick={() => window.confirm(t("pipeline.lists.deleteAsk", { name: l.name })) && del.mutate(l.id)} className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-destructive" aria-label={t("pipeline.lists.delete")} title={t("pipeline.lists.delete")}>
                        <Trash2 className="size-3.5" />
                      </button>
                    </>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        {edit && (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) make.mutate();
            }}
          >
            <div className="flex gap-2">
              <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t("pipeline.lists.name")} className="h-9" />
              <Button type="submit" size="sm" disabled={!name.trim() || make.isPending} className="h-9 bg-grad-gold font-semibold text-[#1a1204]">
                {t("pipeline.lists.add")}
              </Button>
            </div>
            <div className="flex gap-1">
              {([false, true] as const).map((s) => (
                <button key={String(s)} type="button" onClick={() => setShared(s)} className={cn("flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium", shared === s ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10 text-foreground" : "border-transparent text-muted-foreground hover:bg-accent/50")}>
                  {s ? <Users className="size-3.5" /> : <Lock className="size-3.5" />} {t(s ? "pipeline.lists.shared" : "pipeline.lists.personal")}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{t(shared ? "pipeline.lists.sharedHint" : "pipeline.lists.personalHint")}</p>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
