import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { eq } from "drizzle-orm";
import { db, dbReady, schema } from "@/db";
import type { Company } from "@/lib/types";
import { useAuth } from "@/lib/auth";

const STORAGE_KEY = "akab-admin-selected-client";

type SelectedClientContextValue = {
  /** Active client companies (type=client, active). */
  clients: Company[];
  /** Selected client company id, or null if none. */
  selectedClientId: number | null;
  /** Selected company row, or null. */
  selectedClient: Company | null;
  loading: boolean;
  setSelectedClientId: (id: number | null) => void;
  refreshClients: () => Promise<void>;
};

const SelectedClientContext =
  createContext<SelectedClientContextValue | null>(null);

function readStoredId(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeStoredId(id: number | null) {
  try {
    if (id == null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(id));
  } catch {
    /* ignore */
  }
}

export function SelectedClientProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const isStaff = user?.role === "admin" || user?.role === "technician";
  const [clients, setClients] = useState<Company[]>([]);
  const [selectedClientId, setSelectedClientIdState] = useState<number | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const refreshClients = useCallback(async () => {
    if (!isStaff) {
      setClients([]);
      setSelectedClientIdState(null);
      setLoading(false);
      return;
    }
    await dbReady;
    const rows = (await db.select().from(schema.companies)) as Company[];
    const list = rows
      .filter((c) => c.type === "client" && c.active)
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
    setClients(list);

    const stored = readStoredId();
    const stillValid = stored != null && list.some((c) => c.id === stored);
    if (stillValid) {
      setSelectedClientIdState(stored);
    } else {
      const pick = list[0]?.id ?? null;
      setSelectedClientIdState(pick);
      writeStoredId(pick);
    }
    setLoading(false);
  }, [isStaff]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await refreshClients();
      } catch {
        if (!cancelled) {
          setClients([]);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshClients]);

  // Keep selected company fresh if list reloads
  useEffect(() => {
    if (selectedClientId == null) return;
    if (clients.some((c) => c.id === selectedClientId)) return;
    const pick = clients[0]?.id ?? null;
    setSelectedClientIdState(pick);
    writeStoredId(pick);
  }, [clients, selectedClientId]);

  const setSelectedClientId = useCallback((id: number | null) => {
    setSelectedClientIdState(id);
    writeStoredId(id);
  }, []);

  const selectedClient = useMemo(() => {
    if (selectedClientId == null) return null;
    return clients.find((c) => c.id === selectedClientId) ?? null;
  }, [clients, selectedClientId]);

  // Soft-refresh single company when selected (keeps SharePoint/IT Glue fields current)
  useEffect(() => {
    if (!isStaff || selectedClientId == null) return;
    let cancelled = false;
    (async () => {
      try {
        await dbReady;
        const rows = await db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.id, selectedClientId))
          .limit(1);
        const row = rows[0] as Company | undefined;
        if (cancelled || !row) return;
        setClients((prev) => {
          const idx = prev.findIndex((c) => c.id === row.id);
          if (idx < 0) return prev;
          const next = [...prev];
          next[idx] = row;
          return next;
        });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isStaff, selectedClientId]);

  const value = useMemo(
    () => ({
      clients,
      selectedClientId,
      selectedClient,
      loading,
      setSelectedClientId,
      refreshClients,
    }),
    [
      clients,
      selectedClientId,
      selectedClient,
      loading,
      setSelectedClientId,
      refreshClients,
    ],
  );

  return (
    <SelectedClientContext.Provider value={value}>
      {children}
    </SelectedClientContext.Provider>
  );
}

export function useSelectedClient() {
  const ctx = useContext(SelectedClientContext);
  if (!ctx) {
    throw new Error(
      "useSelectedClient must be used within SelectedClientProvider",
    );
  }
  return ctx;
}

/** Optional hook — returns null outside provider (client shell). */
export function useSelectedClientOptional() {
  return useContext(SelectedClientContext);
}
