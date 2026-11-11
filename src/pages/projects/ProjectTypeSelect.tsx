import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";

export type ProjectType = { id: string; name: string };
const NEW = "__new__";
const NONE = "__none__";

/** The kinds of project the team keeps (computer order, installation, onboarding…), with a way to add one on the spot. */
export function useProjectTypes() {
  return useQuery({ queryKey: ["projects", "types"], queryFn: () => api.get<ProjectType[]>("/projects/types"), staleTime: 60_000 });
}

export function ProjectTypeSelect({ value, onChange, disabled, canAdd = true, compact }: { value: string | null; onChange: (id: string | null) => void; disabled?: boolean; canAdd?: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: types = [] } = useProjectTypes();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.post<ProjectType>("/projects/types", { name: name.trim() }),
    onSuccess: (made) => {
      void qc.invalidateQueries({ queryKey: ["projects", "types"] });
      onChange(made.id);
      setAdding(false);
      setName("");
    },
    onError: () => toast.error(t("common.error")),
  });
  if (adding) {
    return (
      <div className="flex items-center gap-1.5">
        <Input autoFocus maxLength={80} value={name} placeholder={t("projectType.newPlaceholder")} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? (e.preventDefault(), name.trim() && create.mutate()) : e.key === "Escape" && setAdding(false))} />
        <Button type="button" size="icon" variant="outline" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()} aria-label={t("projectType.add")}>
          {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
        </Button>
        <Button type="button" size="icon" variant="ghost" onClick={() => setAdding(false)} aria-label={t("common.cancel")}>
          <X className="size-4" />
        </Button>
      </div>
    );
  }
  return (
    <Select disabled={disabled} value={value ?? NONE} onValueChange={(v) => (v === NEW ? setAdding(true) : onChange(v === NONE ? null : v))}>
      <SelectTrigger size={compact ? "sm" : "default"} className={compact ? "h-7 w-full gap-1 border-transparent bg-transparent px-1.5 text-xs shadow-none hover:border-border" : undefined}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        <SelectItem value={NONE}>{t("projectType.none")}</SelectItem>
        {types.map((x) => (
          <SelectItem key={x.id} value={x.id}>
            {x.name}
          </SelectItem>
        ))}
        {canAdd && <SelectItem value={NEW}>{t("projectType.new")}</SelectItem>}
      </SelectContent>
    </Select>
  );
}
