import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
type Contact = { id: string; name: string; email?: string | null };
type CrmContact = { id: string; firstName: string; lastName: string; email: string | null; active: boolean };
import { projError } from "./ProjTasks";
import type { ProjDetail } from "./shared";

const selectCls = "h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-violet-500/40 disabled:opacity-60";

/** The client card of an opened project: client, lead, contact, dates and team. */
export function ProjSide({ project }: { project: ProjDetail }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const clientId = project.client?.id ?? null;
  const canEdit = can("proj.edit");

  const contacts = useQuery({
    queryKey: ["proj", "contacts", clientId],
    queryFn: async (): Promise<Contact[]> => (await api.get<CrmContact[]>(`/crm/clients/${encodeURIComponent(clientId ?? "")}/contacts`)).filter((c) => c.active).map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}`.trim(), email: c.email })),
    enabled: Boolean(clientId),
    staleTime: 5 * 60_000,
  });

  const setContact = useMutation({
    mutationFn: (contactId: string | null) => api.patch(`/proj/${project.id}`, { contactId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proj"] }),
    onError: (e) => toast.error(projError(t, e)),
  });

  const list = contacts.data ?? [];
  const current = project.contact;
  const knownContact = !current || list.some((c) => c.id === current.id);
  const fmtDate = (d: string | null) => d ?? t("proj.side.notSet");

  return (
    <section aria-labelledby="proj-side-title" className="glass space-y-4 rounded-2xl border border-violet-500/25 p-4">
      <h3 id="proj-side-title" className="sr-only">
        {t("proj.side.client")}
      </h3>

      <div className="space-y-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("proj.side.client")}</div>
        {project.client ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-sm font-semibold">{project.client.name}</span>
            {can("crm.view") && (
              <Link to={`/crm/${encodeURIComponent(project.client.id)}`} aria-label={t("proj.side.openClient")} title={t("proj.side.openClient")} className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-white/10 hover:text-foreground">
                <ExternalLink className="size-3.5" aria-hidden />
              </Link>
            )}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">{t("proj.side.noClient")}</div>
        )}
      </div>

      <div className="space-y-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("proj.side.lead")}</div>
        <div className="text-sm">{project.lead?.name ?? t("proj.side.notSet")}</div>
      </div>

      {clientId && (
        <label className="block space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("proj.side.contact")}</span>
          <select
            className={selectCls}
            value={current?.id ?? ""}
            disabled={!canEdit || setContact.isPending}
            onChange={(e) => setContact.mutate(e.target.value || null)}
          >
            <option value="">{list.length ? t("proj.side.contactPick") : t("proj.side.noContact")}</option>
            {!knownContact && current && <option value={current.id}>{current.name}</option>}
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {`${c.name}`.trim() || c.email || c.id}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="space-y-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("proj.side.dates")}</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("proj.side.due")}</dt>
          <dd className="tabular-nums">{fmtDate(project.dueDate)}</dd>
        </dl>
      </div>

      <div className="space-y-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("proj.side.team")}</div>
        {project.members.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t("proj.side.noTeam")}</div>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {project.members.map((m) => (
              <li key={m.id} className="rounded-full bg-violet-500/15 px-2 py-0.5 text-xs text-violet-200">
                {m.name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
