import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Headset, Mail, MapPin, PhoneCall, Ticket, type LucideIcon } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { pageSizeOf } from "@/components/Pager";
import { OPP_LOST_REASONS, type OppHandling, type OppLinkKind, type OppSource, type OppStatus } from "@shared/opps";

export type OppLostReason = (typeof OPP_LOST_REASONS)[number];

export type OppClient = { id: string; name: string };
export type OppRow = {
  id: string;
  number: string;
  client: OppClient | null;
  contact: { id: string; name: string; email: string | null; phone: string | null } | null;
  owner: { id: string; name: string } | null;
  createdBy: string | null;
  status: OppStatus;
  handling: OppHandling;
  source: OppSource;
  ticket: { id: number; number: string; title: string } | null;
  linkCount: number;
  createdAt: string;
  closedAt: string | null;
  lostReason?: OppLostReason | null;
  description: string;
};
export type OppLink = { id: string; kind: OppLinkKind; refId: string; label: string; valueCents?: number | null; marginCents?: number | null };
export type OppNote = { id: string; kind: string; text: string; author: string | null; createdAt: string };
export type OppDetail = OppRow & { links: OppLink[]; notes: OppNote[]; closeNote?: string | null };
export type OppList = { rows: OppRow[]; total: number; counts: { open: number; new: number; working: number; closed: number } };
export type OppBadge = { new: number; mine: number };
export type OppCandidate = { id: string; name: string; sales: boolean };
export type OppReport = {
  from: string;
  to: string;
  /** false without the money right: the value and margin columns are then left out */
  money: boolean;
  totals: {
    total: number;
    byStatus: Record<OppStatus, number>;
    open: number;
    closed: number;
    conversionPct: number | null;
    avgDaysToClose: number | null;
    wonValueCents: number | null;
    wonMarginCents: number | null;
  };
  bySource: Record<string, number>;
  byTechnician: { name: string; count: number }[];
  closed: (OppRow & { valueCents: number | null; marginCents: number | null; links: (OppLink & { valueCents: number | null; marginCents: number | null })[] })[];
};

export const SOURCE_ICON: Record<OppSource, LucideIcon> = {
  ticket: Ticket,
  sales_call: PhoneCall,
  tech_call: Headset,
  onsite: MapPin,
  email: Mail,
  other: Ticket,
};

/** Tailwind tone of a status pill (ink-friendly, dark theme) */
export const STATUS_TONE: Record<OppStatus, string> = {
  new: "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/15 text-[color:var(--gold)]",
  working: "border-sky-400/40 bg-sky-400/10 text-sky-300",
  won: "border-emerald-400/50 bg-emerald-400/10 text-emerald-300",
  lost: "border-red-400/50 bg-red-400/10 text-red-300",
  canceled: "border-zinc-400/40 bg-zinc-400/10 text-zinc-300",
};

export const OPEN_TABS = ["open", "archives", "report"] as const;
export type OppTab = (typeof OPEN_TABS)[number];

/** Turns a failed call into the text of the matching error (falls back on the generic one). */
export function oppError(e: unknown, t: (k: string) => string): string {
  if (e instanceof ApiError && e.code) {
    const key = `opps.errors.${e.code}`;
    const text = t(key);
    if (text !== key) return text;
  }
  return t("opps.common.error");
}

/** List of opportunities for the filters of the page (open or closed, owner, origin, client, search, page). */
export function useOppList(params: { status: "open" | "closed" | "all"; owner?: string; source?: string; client?: string; q?: string; page?: number; size?: number }) {
  const qs = new URLSearchParams();
  qs.set("status", params.status);
  if (params.owner && params.owner !== "all") qs.set("owner", params.owner);
  if (params.source) qs.set("source", params.source);
  if (params.client) qs.set("client", params.client);
  if (params.q) qs.set("q", params.q);
  qs.set("page", String(params.page ?? 1));
  qs.set("size", String(params.size ?? 50));
  return useQuery({
    queryKey: ["opps", "list", Object.fromEntries(qs)],
    // the API answers { items, total, page, size, counts }; the screens call the rows "rows"
    queryFn: async (): Promise<OppList> => {
      const r = await api.get<{ items: OppRow[]; total: number; counts: OppList["counts"] }>(`/opps?${qs}`);
      return { rows: r.items, total: r.total, counts: r.counts };
    },
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useOpp(id: string | null) {
  return useQuery({ queryKey: ["opps", "one", id], queryFn: () => api.get<OppDetail>(`/opps/${id}`), enabled: Boolean(id) });
}

/** The sidebar's counters: new (to take) and mine. Refreshed every minute while the app is open. */
export function useOppBadge(enabled: boolean) {
  return useQuery({ queryKey: ["opps", "badge"], queryFn: () => api.get<OppBadge>("/opps/badge"), refetchInterval: 60_000, enabled });
}

/** Active staff that can own an opportunity (sales ones flagged). Shared by the owner picker and the notify picker. */
export function useOppCandidates(enabled = true) {
  return useQuery({ queryKey: ["opps", "candidates"], queryFn: () => api.get<OppCandidate[]>("/opps/notify-candidates"), staleTime: 5 * 60_000, enabled });
}

/** Opportunities flagged on one ticket (the badge of the ticket window). */
export function useOppsOfTicket(ticketId: number | null) {
  return useQuery({
    queryKey: ["opps", "by-ticket", ticketId],
    queryFn: () => api.get<{ id: string; number: string; status: OppStatus }[]>(`/opps/by-ticket/${ticketId}`),
    enabled: ticketId != null,
  });
}

/** Clients to pick when flagging (active, word by word, 20 at most): opportunities scope, opps.create. */
export function useOppClients(q: string, enabled = true) {
  return useQuery({
    queryKey: ["opps", "clients", q],
    queryFn: () => api.get<OppClient[]>(`/opps/clients?q=${encodeURIComponent(q)}`),
    staleTime: 60_000,
    enabled,
    placeholderData: (prev) => prev,
  });
}

/** The active contacts of one client (opps scope, opps.create). */
export function useOppContacts(clientId: string | null) {
  return useQuery({
    queryKey: ["opps", "contacts", clientId],
    queryFn: () => api.get<{ id: string; name: string; email: string | null; phone: string | null; title: string | null }[]>(`/opps/clients/${clientId}/contacts`),
    enabled: Boolean(clientId),
    staleTime: 60_000,
  });
}

/** What of the client an opportunity can be linked to (opps.manage): quotes, contracts or projects, with the labels the link stores. */
export function useOppLinkables(clientId: string | null, kind: "quote" | "contract" | "project", enabled = true) {
  return useQuery({
    queryKey: ["opps", "linkables", clientId, kind],
    queryFn: () => api.get<{ id: string; label: string }[]>(`/opps/clients/${clientId}/linkables?kind=${kind}`),
    enabled: enabled && Boolean(clientId),
    staleTime: 30_000,
  });
}

/** Any opportunity change: the lists, the open one, the counters and the ticket badges are read again. */
export function useOppMutation<V, R = unknown>(run: (v: V) => Promise<R>, onOk?: (r: R, v: V) => void, onErr?: (e: unknown) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (r, v) => {
      void qc.invalidateQueries({ queryKey: ["opps"] });
      onOk?.(r, v);
    },
    onError: (e) => onErr?.(e),
  });
}

/** A text kept with a small wait before it is written back (search boxes). */
export function useDebounced(value: string, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

const RESET_PAGE = ["tab", "owner", "source", "client", "q", "size"];

/** The page's filters, kept in the address: tab, owner, origin, client, search, page, size, the open opportunity. */
export function useOppFilters() {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get("tab");
  const tab: OppTab = (OPEN_TABS as readonly string[]).includes(raw ?? "") ? (raw as OppTab) : "open";
  const set = (patch: Record<string, string | null>) => {
    setSp(
      (prev) => {
        const n = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === "") n.delete(k);
          else n.set(k, v);
        }
        if (Object.keys(patch).some((k) => RESET_PAGE.includes(k)) && !("page" in patch)) n.delete("page");
        return n;
      },
      { replace: false },
    );
  };
  return {
    tab,
    owner: sp.get("owner") ?? "all",
    source: sp.get("source") ?? "",
    client: sp.get("client") ?? "",
    q: sp.get("q") ?? "",
    page: Math.max(1, Number(sp.get("page") ?? 1) || 1),
    size: pageSizeOf(sp.get("size"), 50),
    opp: sp.get("opp"),
    set,
  };
}
