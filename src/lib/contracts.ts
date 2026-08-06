import { formatApiError } from "@/lib/autotask";

/** Client-safe contract — never includes internal cost/profit/margin. */
export type ClientSafeContract = {
  id: number;
  name: string;
  number: string | null;
  typeLabel: string | null;
  status: number | null;
  statusLabel: string | null;
  isActive: boolean;
  startDate: string | null;
  endDate: string | null;
  description: string | null;
  monthlyAmount: number | null;
  nextInvoiceDate: string | null;
  periodType: number | null;
  periodTypeLabel: string | null;
};

export type ClientContractService = {
  id: number;
  serviceId: number | null;
  name: string;
  description: string | null;
  units: number | null;
  unitPrice: number | null;
  lineTotal: number | null;
  isActive?: boolean;
};

export type ContractsResponse = {
  configured: boolean;
  contracts: ClientSafeContract[];
  error?: string | null;
  activeOnly?: boolean;
  clientVisibleFields?: string[];
  clientHiddenNote?: string;
};

export type ContractServicesResponse = {
  configured: boolean;
  contractId?: number;
  services: ClientContractService[];
  error?: string | null;
};

export async function fetchClientContracts(
  autotaskCompanyId: string,
  opts?: { includeInactive?: boolean },
): Promise<ContractsResponse> {
  const q = new URLSearchParams({ autotaskCompanyId });
  if (opts?.includeInactive) q.set("includeInactive", "1");
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

export async function fetchContractServices(
  contractId: number,
): Promise<ContractServicesResponse> {
  const r = await fetch(`/api/autotask/contracts/${contractId}/services`, {
    headers: { Accept: "application/json" },
  });
  const d = (await r.json()) as ContractServicesResponse;
  if (!r.ok) {
    return {
      configured: Boolean(d.configured),
      services: [],
      error: formatApiError(d.error, `Contract services failed (${r.status})`),
    };
  }
  return {
    ...d,
    services: Array.isArray(d.services) ? d.services : [],
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
