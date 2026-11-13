import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { usePeople } from "@/pages/pipeline/TaskDialog";
import { projError } from "./ProjTasks";
import type { ProjDetail } from "./shared";

type QuoteRow = { id: string; number: string; title: string; status: string; totalCents: number };

const fieldCls = "h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-violet-500/40 disabled:opacity-60";
const labelCls = "block space-y-1";
const labelText = "block text-[11px] font-medium uppercase tracking-wide text-muted-foreground";

/** Creates a project (POST /api/proj) and hands its id back to the caller */
export function NewProjDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  // the portal's own clients (uuid ids), not the ticket companies
  const companies = useQuery({ queryKey: ["proj", "crm-clients"], queryFn: () => api.get<{ id: string; name: string; active?: boolean }[]>("/crm/clients"), staleTime: 5 * 60_000 });
  const people = usePeople();

  const [name, setName] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [clientId, setClientId] = useState("");
  const [leadId, setLeadId] = useState(me.id);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [soldHours, setSoldHours] = useState("");
  const [description, setDescription] = useState("");
  const [quoteId, setQuoteId] = useState("");

  const clients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    const list = companies.data ?? [];
    const filtered = q ? list.filter((c) => c.name.toLowerCase().includes(q)) : list;
    return filtered.slice(0, 200);
  }, [companies.data, clientSearch]);

  const quotes = useQuery({
    queryKey: ["proj", "quotes", clientId],
    queryFn: () => api.get<QuoteRow[]>(`/proj/quotes?clientId=${encodeURIComponent(clientId)}`),
    enabled: Boolean(clientId) && can("quotes.view"),
    staleTime: 30_000,
  });

  const personName = (id: string) => (people.data ?? []).find((p) => p.id === id)?.name ?? id;
  const candidates = (people.data ?? []).filter((p) => p.id !== leadId && !memberIds.includes(p.id));

  const create = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { name: name.trim(), leadId, memberIds };
      if (clientId) body.clientId = clientId;
      if (startDate) body.startDate = startDate;
      if (dueDate) body.dueDate = dueDate;
      const hours = soldHours.trim() === "" ? NaN : Number(soldHours.replace(",", "."));
      if (Number.isFinite(hours) && hours >= 0) body.soldHours = hours;
      if (description.trim()) body.description = description.trim();
      if (quoteId) body.quoteId = quoteId;
      return api.post<ProjDetail>("/proj", body);
    },
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ["proj"] });
      toast.success(t("proj.newProj.created", { number: p.number }));
      onCreated(p.id);
    },
    onError: (e) => toast.error(projError(t, e)),
  });

  const canSubmit = name.trim().length > 0 && !create.isPending;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="glass max-h-[92vh] w-[min(44rem,calc(100vw-1.5rem))] max-w-none gap-0 overflow-hidden rounded-2xl border border-t-4 border-violet-500/40 border-t-violet-500 p-0 sm:max-w-none">
        <div className="flex items-center justify-between gap-2 border-b border-white/10 px-5 py-4">
          <DialogTitle className="text-base font-semibold text-violet-200">{t("proj.newProj.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("proj.tag")}</DialogDescription>
          <Button type="button" variant="ghost" size="icon" aria-label={t("proj.close")} title={t("proj.close")} onClick={onClose}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>

        <form
          className="max-h-[calc(92vh-4.5rem)] space-y-4 overflow-y-auto px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) create.mutate();
          }}
        >
          <label className={labelCls}>
            <span className={labelText}>{t("proj.newProj.name")}</span>
            <Input value={name} maxLength={200} autoFocus onChange={(e) => setName(e.target.value)} required />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <span className={labelText}>{t("proj.newProj.client")}</span>
              <Input
                value={clientSearch}
                placeholder={t("proj.newProj.clientSearch")}
                aria-label={t("proj.newProj.clientSearch")}
                onChange={(e) => setClientSearch(e.target.value)}
              />
              <select
                className={cn(fieldCls, "mt-1")}
                value={clientId}
                aria-label={t("proj.newProj.client")}
                onChange={(e) => {
                  setClientId(e.target.value);
                  setQuoteId("");
                }}
              >
                <option value="">{t("proj.newProj.clientNone")}</option>
                {clientId && !clients.some((c) => String(c.id) === clientId) && <option value={clientId}>{(companies.data ?? []).find((c) => String(c.id) === clientId)?.name ?? clientId}</option>}
                {clients.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <label className={labelCls}>
              <span className={labelText}>{t("proj.newProj.lead")}</span>
              <select className={fieldCls} value={leadId} onChange={(e) => setLeadId(e.target.value)}>
                {(people.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                {!(people.data ?? []).some((p) => p.id === me.id) && <option value={me.id}>{me.name ?? me.id}</option>}
              </select>
            </label>
          </div>

          <div className="space-y-1">
            <span className={labelText}>{t("proj.newProj.team")}</span>
            <div className="flex flex-wrap gap-1.5">
              {memberIds.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 py-0.5 pl-2.5 pr-1 text-xs text-violet-200">
                  {personName(id)}
                  <button
                    type="button"
                    aria-label={`${t("proj.team.remove", { name: personName(id) })}`}
                    onClick={() => setMemberIds((ids) => ids.filter((x) => x !== id))}
                    className="grid size-4 place-items-center rounded-full hover:bg-white/10"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
              <select
                className="h-7 rounded-md border bg-transparent px-2 text-xs outline-none focus:ring-2 focus:ring-violet-500/40"
                value=""
                aria-label={t("proj.newProj.teamAdd")}
                onChange={(e) => {
                  const id = e.target.value;
                  if (id) setMemberIds((ids) => [...ids, id]);
                }}
              >
                <option value="">{t("proj.newProj.teamAdd")}</option>
                {candidates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <label className={labelCls}>
              <span className={labelText}>{t("proj.newProj.startDate")}</span>
              <input type="date" className={fieldCls} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </label>
            <label className={labelCls}>
              <span className={labelText}>{t("proj.newProj.dueDate")}</span>
              <input type="date" className={fieldCls} value={dueDate} min={startDate || undefined} onChange={(e) => setDueDate(e.target.value)} />
            </label>
            <label className={labelCls}>
              <span className={labelText}>{t("proj.newProj.soldHours")}</span>
              <Input type="number" inputMode="decimal" min={0} max={100000} step={0.25} value={soldHours} onChange={(e) => setSoldHours(e.target.value)} />
            </label>
          </div>

          {clientId && can("quotes.view") && (
            <label className={labelCls}>
              <span className={labelText}>{t("proj.newProj.quote")}</span>
              <select className={fieldCls} value={quoteId} onChange={(e) => setQuoteId(e.target.value)}>
                <option value="">{t("proj.newProj.quoteNone")}</option>
                {(quotes.data ?? []).map((q) => (
                  <option key={q.id} value={q.id}>
                    {`${q.number} · ${q.title}`}
                  </option>
                ))}
              </select>
              <span className="block text-[11px] text-muted-foreground">{t("proj.newProj.quoteHint")}</span>
            </label>
          )}

          <label className={labelCls}>
            <span className={labelText}>{t("proj.newProj.description")}</span>
            <Textarea value={description} maxLength={8000} rows={4} onChange={(e) => setDescription(e.target.value)} />
          </label>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("proj.newProj.cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {create.isPending ? t("proj.newProj.creating") : t("proj.newProj.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
