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
  const preview = useQuery({ queryKey: ["tickets", "to-project", tk.id], queryFn: () => api.get<Preview>(`/tickets/${tk.id}/to-project`) });
  const go = useMutation({
    mutationFn: () => api.post<{ project: { id: string; number: string } }>(`/tickets/${tk.id}/to-project`, { name: name.trim() || undefined }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success(t("tickets.toProject.done", { project: r.project.number }));
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
        <div className="space-y-1.5">
          <Label className="text-xs">{t("tickets.toProject.name")}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </div>
        <p className="text-sm text-muted-foreground">{t("tickets.toProject.text")}</p>
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
        <p className="text-xs text-muted-foreground">{t("tickets.toProject.closes")}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!name.trim() || go.isPending || preview.isLoading} onClick={() => go.mutate()}>
            {go.isPending ? <Loader2 className="size-4 animate-spin" /> : <FolderKanban className="size-4" />} {t("tickets.toProject.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
