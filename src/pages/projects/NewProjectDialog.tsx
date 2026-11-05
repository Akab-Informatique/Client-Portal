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
import { cn } from "@/lib/utils";
import { useMe } from "@/lib/session";
import { useCrmClients } from "@/pages/crm/shared";
import { apiMessage, useProjectPeople, type BillingMode, type Project } from "./shared";

const MODES: BillingMode[] = ["contract", "hourly", "special"];

/**
 * New project: its name, the client, the leader, the team (the tasks are given to them), the start and due days, the
 * hours planned, how often to follow up (the checkpoint), and how it is billed — under a contract, at an hourly rate
 * set here, or at a special rate. The phases (milestones) and their tasks are added afterwards, in their own window.
 */
export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const { data: people = [] } = useProjectPeople();
  const { data: clients = [] } = useCrmClients();
  const { data: defaults } = useQuery({ queryKey: ["projects", "defaults"], queryFn: () => api.get<{ hourlyRate: number }>("/projects/defaults"), staleTime: 60_000 });
  const [f, setF] = useState({ name: "", clientId: "", leadId: me.id, startDate: "", dueDate: "", budget: "", every: "", checkpointDate: "", description: "", mode: "hourly" as BillingMode, contractId: "", rate: "", special: "" });
  const [team, setTeam] = useState<string[]>([]);
  const { data: contracts = [] } = useQuery({ queryKey: ["projects", "client-contracts", f.clientId], queryFn: () => api.get<{ id: string; name: string; hourlyRate: number | null }[]>(`/projects/client-contracts/${f.clientId}`), enabled: Boolean(f.clientId), staleTime: 30_000 });
  const num = (v: string) => (v.trim() ? Number(v.replace(",", ".")) : null);
  const budget = num(f.budget);
  const every = num(f.every);
  const rate = f.mode === "special" ? num(f.special) : num(f.rate);
  const create = useMutation({
    mutationFn: () =>
      api.post<Project>("/projects", {
        name: f.name.trim(),
        clientId: f.clientId || null,
        leadId: f.leadId || null,
        memberIds: team,
        startDate: f.startDate || null,
        dueDate: f.dueDate || null,
        budgetHours: budget,
        checkpointEveryDays: every,
        checkpointDate: every && f.checkpointDate ? f.checkpointDate : undefined,
        billingMode: f.mode,
        contractId: f.mode === "contract" ? f.contractId : null,
        hourlyRate: f.mode === "contract" ? null : f.mode === "special" ? rate : (rate ?? defaults?.hourlyRate ?? null),
        description: f.description.trim(),
      }),
    onSuccess: (p) => {
      toast.success(t("projects.created", { number: p.number }));
      onCreated(p.id);
    },
    onError: (e) => toast.error(apiMessage(e instanceof ApiError ? e.code : undefined, t)),
  });
  const billingOk = f.mode === "contract" ? Boolean(f.clientId && f.contractId) : f.mode === "special" ? rate != null && rate > 0 : rate === null || rate >= 0;
  const valid = f.name.trim().length > 0 && (budget === null || (Number.isFinite(budget) && budget >= 0)) && (every === null || (Number.isInteger(every) && every >= 1 && every <= 365)) && !(f.startDate && f.dueDate && f.dueDate < f.startDate) && billingOk;
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlus className="size-5 text-primary" /> {t("projects.newTitle")}
          </DialogTitle>
          <DialogDescription>{t("projects.newText")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid && !create.isPending) create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="pj-name">{t("projects.f.name")}</Label>
            <Input id="pj-name" autoFocus required maxLength={200} value={f.name} onChange={(e) => set("name")(e.target.value)} placeholder={t("projects.f.namePlaceholder")} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("projects.f.client")}</Label>
              <Select value={f.clientId || "none"} onValueChange={(v) => setF((s) => ({ ...s, clientId: v === "none" ? "" : v, contractId: "" }))}>
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
            <p className="text-xs text-muted-foreground">{t("projects.teamHint")}</p>
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
            <Label>{t("projects.ov.followup")}</Label>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-center gap-2 text-sm">
                {t("projects.ov.every")}
                <Input type="number" min={1} max={365} value={f.every} onChange={(e) => set("every")(e.target.value)} className="h-9 w-20" placeholder="7" aria-label={t("projects.ov.every")} />
                {t("projects.ov.days")}
              </div>
              <div className="flex items-center gap-2 text-sm">
                {t("projects.ov.firstFollowup")}
                <Input type="date" disabled={!f.every} value={f.checkpointDate} onChange={(e) => set("checkpointDate")(e.target.value)} className="h-9" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("projects.ov.followupHint")}</p>
          </div>

          <div className="space-y-2 rounded-xl border p-3">
            <Label>{t("projects.billingMode")}</Label>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("projects.billingMode")}>
              {MODES.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={f.mode === m} onClick={() => set("mode")(m)} className={cn("rounded-xl border px-3 py-2 text-left transition-colors", f.mode === m ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10" : "bg-muted/30 hover:bg-accent/40")}>
                  <span className="block text-sm font-medium">{t(`projects.mode.${m}`)}</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">{t(`projects.modeHint.${m}`)}</span>
                </button>
              ))}
            </div>
            {f.mode === "contract" &&
              (!f.clientId ? (
                <p className="text-xs text-amber-300">{t("projects.errors.contract_needs_client")}</p>
              ) : contracts.length === 0 ? (
                <p className="text-xs text-amber-300">{t("projects.noContracts")}</p>
              ) : (
                <Select value={f.contractId} onValueChange={set("contractId")}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("projects.pickContract")} />
                  </SelectTrigger>
                  <SelectContent>
                    {contracts.map((k) => (
                      <SelectItem key={k.id} value={k.id}>
                        {k.name} — {k.hourlyRate == null ? t("projects.hoursIncluded") : `${k.hourlyRate} $/h`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ))}
            {f.mode === "hourly" && (
              <div className="flex items-center gap-2 text-sm">
                <Input inputMode="decimal" value={f.rate} onChange={(e) => set("rate")(e.target.value)} placeholder={defaults ? `${defaults.hourlyRate}` : ""} className="h-9 w-28" aria-label={t("projects.hourlyRate")} /> {t("projects.hourlyRate")}
              </div>
            )}
            {f.mode === "special" && (
              <div className="flex items-center gap-2 text-sm">
                <Input inputMode="decimal" value={f.special} onChange={(e) => set("special")(e.target.value)} className="h-9 w-28" aria-label={t("projects.specialRate")} /> {t("projects.specialRate")}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pj-desc">{t("projects.f.description")}</Label>
            <Textarea id="pj-desc" rows={3} value={f.description} onChange={(e) => set("description")(e.target.value)} placeholder={t("projects.f.descriptionPlaceholder")} />
            <p className="text-xs text-muted-foreground">{t("projects.phasesLater")}</p>
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
