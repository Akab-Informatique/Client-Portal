import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/session";
import { ListSelect, listError, rememberList, rememberedList, useTaskLists, type Space } from "./lists";
import { taskError, usePeople } from "./TaskDialog";

/**
 * Add a task in one go: its words, the list (a shared list for a task, one of one's own for a to-do, or none), who has it (a task
 * only: a to-do is the person's own) and a due day. `listId` fixes the list when one is already open.
 */
export function TaskQuickAdd({ space, listId, defaultDue, onAdded, className }: { space: Space; listId?: string | null; defaultDue?: string; onAdded?: () => void; className?: string }) {
  const { t } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const lists = useTaskLists();
  const people = usePeople();
  const [title, setTitle] = useState("");
  const [pick, setPick] = useState("");
  const [who, setWho] = useState("");
  const [due, setDue] = useState(defaultDue ?? "");
  const list = listId ?? (pick || (space === "tasks" ? rememberedList(lists.data) : ""));
  const add = useMutation({
    mutationFn: () => api.post("/pipeline/tasks", { title: title.trim(), space, listId: list || undefined, ...(space === "tasks" ? { assigneeId: who || me.id } : {}), dueDate: due || null }),
    onSuccess: () => {
      setTitle("");
      setDue(defaultDue ?? "");
      void qc.invalidateQueries({ queryKey: ["pipeline"] });
      onAdded?.();
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "list_invalid" ? listError(t, e) : taskError(t, e)),
  });
  return (
    <form
      className={"glass flex flex-wrap items-center gap-2 rounded-2xl border p-2.5 " + (className ?? "")}
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) add.mutate();
      }}
    >
      <Plus className="ml-2 size-4 shrink-0 text-primary" />
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t(space === "tasks" ? "pipeline.quick.task" : "pipeline.quick.todo")} className="h-9 min-w-40 flex-1 border-transparent bg-transparent shadow-none focus-visible:border-input" maxLength={200} />
      {listId === undefined && <ListSelect value={list} onChange={(id) => (setPick(id), space === "tasks" && rememberList(id))} lists={lists.data} space={space} all={space === "todo" ? t("pipeline.lists.noList") : undefined} label={t("pipeline.quick.list")} className="h-9 max-w-44 shrink-0 text-xs" />}
      {space === "tasks" && (
        <select value={who || me.id} onChange={(e) => setWho(e.target.value)} aria-label={t("pipeline.quick.who")} className="h-9 max-w-36 shrink-0 rounded-md border bg-transparent px-2 text-xs">
          {(people.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === me.id ? t("pipeline.team.me", { name: p.name }) : p.name}
            </option>
          ))}
        </select>
      )}
      <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label={t("pipeline.quick.due")} className="h-9 w-36 shrink-0 text-xs" />
      <button type="submit" disabled={!title.trim() || add.isPending} className="h-9 rounded-md bg-grad-gold px-4 text-sm font-semibold text-[#1a1204] disabled:opacity-50">
        {t("pipeline.add")}
      </button>
    </form>
  );
}
