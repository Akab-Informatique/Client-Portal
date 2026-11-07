import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FolderKanban, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";

type Preview = { notes: number; checklist: number; files: number; time: { moved: number; stays: number }; charges: { moved: number; stays: number } };

/**
 * "Transformer en projet": the ticket becomes a project. Notes are copied, the time and charges not approved or billed
 * yet move (the ticket's time is then not billable), what is approved or invoiced stays, and the ticket is closed.
 */
export function ToProjectDialog({ tk, onClose, onDone }: { tk: { id: number; number: string; title: string }; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(tk.title);
  // a new project, or one of this client's open projects (the ticket is merged into it)
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [into, setInto] = useState("");
  const targets = useQuery({ queryKey: ["tickets", "to-project-targets", tk.id], queryFn: () => api.get<{ id: string; number: string; name: string; status: string }[]>(`/tickets/${tk.id}/to-project/targets`) });
  const choices = targets.data ?? [];
  const preview = useQuery({ queryKey: ["tickets", "to-project", tk.id], queryFn: () => api.get<Preview>(`/tickets/${tk.id}/to-project`) });
  const go = useMutation({
    mutationFn: () => api.post<{ project: { id: string; number: string } }>(`/tickets/${tk.id}/to-project`, mode === "existing" ? { intoProjectId: into } : { name: name.trim() || undefined }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success(t(mode === "existing" ? "tickets.toProject.doneInto" : "tickets.toProject.done", { project: r.project.number }));
      onDone();
      navigate(`/projects?project=${r.project.id}`);
    },
    onError: (e) => {
      const code = e instanceof ApiError ? e.code : "";
      toast.error(code && t(`tickets.toProject.errors.${code}`, { defaultValue: "" }) ? t(`tickets.toProject.errors.${code}`) : t("tickets.toProject.errors.generic"));
    },
  });
  const p = preview.data;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderKanban className="size-5 text-primary" /> {t("tickets.toProject.title")}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-primary">{tk.number}</span> · {tk.title}
          </DialogDescription>
        </DialogHeader>
        <div className="flex overflow-hidden rounded-lg border text-sm" role="group">
          {(["new", "existing"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={cn("flex-1 px-3 py-1.5", mode === m ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground")}>
              {t(m === "new" ? "tickets.toProject.modeNew" : "tickets.toProject.modeExisting")}
            </button>
          ))}
        </div>
        {mode === "new" ? (
          <div className="space-y-1.5">
            <Label className="text-xs">{t("tickets.toProject.name")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label className="text-xs">{t("tickets.toProject.pick")}</Label>
            {targets.isLoading ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : choices.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{t("tickets.toProject.noTargets")}</p>
            ) : (
              <Select value={into} onValueChange={setInto}>
                <SelectTrigger>
                  <SelectValue placeholder={t("tickets.toProject.pickPlaceholder")} />
                </SelectTrigger>
                <SelectContent position="popper">
                  {choices.map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      {x.number} · {x.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
        <p className="text-sm text-muted-foreground">{t(mode === "new" ? "tickets.toProject.text" : "tickets.toProject.textInto")}</p>
        {preview.isLoading ? (
          <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />
        ) : (
          p && (
            <ul className="space-y-1 rounded-lg border bg-background/30 p-3 text-sm">
              <li>{t("tickets.toProject.notes", { count: p.notes })}</li>
              <li>{t("tickets.toProject.checklist", { count: p.checklist })}</li>
              <li>{t("tickets.toProject.files", { count: p.files })}</li>
              <li>{t("tickets.toProject.time", { moved: p.time.moved, stays: p.time.stays })}</li>
              <li>{t("tickets.toProject.charges", { moved: p.charges.moved, stays: p.charges.stays })}</li>
            </ul>
          )
        )}
        <p className="text-xs text-muted-foreground">{t(mode === "new" ? "tickets.toProject.closes" : "tickets.toProject.closesInto")}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={(mode === "new" ? !name.trim() : !into) || go.isPending || preview.isLoading} onClick={() => go.mutate()}>
            {go.isPending ? <Loader2 className="size-4 animate-spin" /> : <FolderKanban className="size-4" />} {t(mode === "new" ? "tickets.toProject.confirm" : "tickets.toProject.confirmInto")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
