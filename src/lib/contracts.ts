import { formatApiError } from "@/lib/autotask";

/** Client-safe contract — never includes cost/profit/margin. */
export type ClientSafeContract = {
  id: number;
  name: string;
  number: string | null;
  typeLabel: string | null;
  statusLabel: string | null;
  startDate: string | null;
  endDate: string | null;
  description: string | null;
};

export type ContractsResponse = {
  configured: boolean;
  contracts: ClientSafeContract[];
  error?: string | null;
  clientVisibleFields?: string[];
  clientHiddenNote?: string;
};

export async function fetchClientContracts(
  autotaskCompanyId: string,
): Promise<ContractsResponse> {
  const q = new URLSearchParams({ autotaskCompanyId });
  const r = await fetch(`/api/autotask/contracts?${q}`, {
    headers: { Accept: "application/json" },
  });
  const d = (await r.json()) as ContractsResponse;
  if (!r.ok) {
    return {
      configured: Boolean(d.configured),
      contracts: [],
      error: formatApiError(d.error, `Contracts failed (${r.status})`),
    };
  }
  return {
    ...d,
    contracts: Array.isArray(d.contracts) ? d.contracts : [],
    error: d.error ? formatApiError(d.error) : null,
  };
}

export function formatContractDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}
