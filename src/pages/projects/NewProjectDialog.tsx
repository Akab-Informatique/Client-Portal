import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { FolderPlus, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/session";
import { useCrmClients } from "@/pages/crm/shared";
import { apiMessage, useProjectPeople, type Project } from "./shared";

/** New project: a name is enough; the client, the lead, the dates, the team and a first list of milestones can come with it. */
export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const { data: people = [] } = useProjectPeople();
  const { data: clients = [] } = useCrmClients();
  const { data: defaults } = useQuery({ queryKey: ["projects", "defaults"], queryFn: () => api.get<{ hourlyRate: number }>("/projects/defaults"), staleTime: 60_000 });
  const [f, setF] = useState({ name: "", clientId: "", leadId: me.id, startDate: "", dueDate: "", budget: "", description: "", milestones: "", mode: "hourly" as "hourly" | "fixed", rate: "", fixedPrice: "" });
  const [team, setTeam] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: () =>
      api.post<Project>("/projects", {
        name: f.name.trim(),
        clientId: f.clientId || null,
        leadId: f.leadId || null,
        memberIds: team,
        startDate: f.startDate || null,
        dueDate: f.dueDate || null,
        budgetHours: f.budget.trim() ? Number(f.budget.replace(",", ".")) : null,
        billingMode: f.mode,
        hourlyRate: f.rate.trim() ? Number(f.rate.replace(",", ".")) : (defaults?.hourlyRate ?? null),
        fixedPrice: f.mode === "fixed" && f.fixedPrice.trim() ? Number(f.fixedPrice.replace(",", ".")) : null,
        description: f.description.trim(),
        milestones: f.milestones
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((name) => ({ name })),
      }),
    onSuccess: (p) => {
      toast.success(t("projects.created", { number: p.number }));
      onCreated(p.id);
    },
    onError: (e) => toast.error(apiMessage(e instanceof ApiError ? e.code : undefined, t)),
  });
  const budgetOk = !f.budget.trim() || Number.isFinite(Number(f.budget.replace(",", "."))) && Number(f.budget.replace(",", ".")) >= 0;
  const valid = f.name.trim().length > 0 && budgetOk && !(f.startDate && f.dueDate && f.dueDate < f.startDate);
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlus className="size-5 text-primary" /> {t("projects.newTitle")}
          </DialogTitle>
          <DialogDescription>{t("projects.newText")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid) create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="pj-name">{t("projects.f.name")}</Label>
            <Input id="pj-name" autoFocus required maxLength={200} value={f.name} onChange={(e) => set("name")(e.target.value)} placeholder={t("projects.f.namePlaceholder")} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("projects.f.client")}</Label>
              <Select value={f.clientId || "none"} onValueChange={(v) => set("clientId")(v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="none">{t("projects.f.noClient")}</SelectItem>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("projects.f.lead")}</Label>
              <Select value={f.leadId || "none"} onValueChange={(v) => set("leadId")(v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("projects.f.noLead")}</SelectItem>
                  {people.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="pj-start">{t("projects.f.start")}</Label>
              <Input id="pj-start" type="date" value={f.startDate} onChange={(e) => set("startDate")(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pj-due">{t("projects.f.due")}</Label>
              <Input id="pj-due" type="date" value={f.dueDate} min={f.startDate || undefined} onChange={(e) => set("dueDate")(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pj-budget">{t("projects.f.budget")}</Label>
              <Input id="pj-budget" inputMode="decimal" value={f.budget} onChange={(e) => set("budget")(e.target.value)} placeholder="40" />
            </div>
          </div>
          <div className="space-y-2 rounded-xl border p-3">
            <Label>{t("projects.billingMode")}</Label>
            <div className="grid gap-3 sm:grid-cols-3">
              <Select value={f.mode} onValueChange={(v) => setF((x) => ({ ...x, mode: v as "hourly" | "fixed" }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hourly">{t("projects.mode.hourly")}</SelectItem>
                  <SelectItem value="fixed">{t("projects.mode.fixed")}</SelectItem>
                </SelectContent>
              </Select>
              <Input inputMode="decimal" value={f.rate} onChange={(e) => set("rate")(e.target.value)} placeholder={defaults ? `${defaults.hourlyRate} $/h` : t("projects.hourlyRate")} aria-label={t("projects.hourlyRate")} />
              {f.mode === "fixed" && <Input inputMode="decimal" value={f.fixedPrice} onChange={(e) => set("fixedPrice")(e.target.value)} placeholder={t("projects.fixedPrice")} aria-label={t("projects.fixedPrice")} />}
            </div>
            <p className="text-xs text-muted-foreground">{f.mode === "hourly" ? t("projects.modeHintHourly") : t("projects.modeHintFixed")}</p>
          </div>
          <div className="space-y-1.5">
            <Label>{t("projects.f.team")}</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {team.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-full border bg-card/60 py-0.5 pl-2.5 pr-1 text-xs">
                  {nameOf(id)}
                  <button type="button" aria-label={t("common.delete")} className="rounded-full p-0.5 text-muted-foreground hover:text-destructive" onClick={() => setTeam((s) => s.filter((x) => x !== id))}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <Select value="" onValueChange={(v) => v && setTeam((s) => (s.includes(v) ? s : [...s, v]))}>
                <SelectTrigger className="h-7 w-44 text-xs">
                  <SelectValue placeholder={t("projects.f.addMember")} />
                </SelectTrigger>
                <SelectContent>
                  {people
                    .filter((p) => p.id !== f.leadId && !team.includes(p.id))
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pj-ms">{t("projects.f.milestones")}</Label>
            <Textarea id="pj-ms" rows={4} value={f.milestones} onChange={(e) => set("milestones")(e.target.value)} placeholder={t("projects.f.milestonesPlaceholder")} />
            <p className="text-xs text-muted-foreground">{t("projects.f.milestonesHint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pj-desc">{t("projects.f.description")}</Label>
            <Textarea id="pj-desc" rows={3} value={f.description} onChange={(e) => set("description")(e.target.value)} placeholder={t("projects.f.descriptionPlaceholder")} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || create.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {create.isPending && <Loader2 className="size-4 animate-spin" />} {t("projects.newCreate")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
