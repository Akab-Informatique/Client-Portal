import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { AuthState, Me } from "./types";
import type { PermissionKey } from "@shared/permissions";
import { currentLocale, setLocale } from "@/i18n";

const SessionCtx = createContext<Me | null>(null);

export function useAuthState() {
  return useQuery({
    queryKey: ["auth"],
    queryFn: () => api.get<AuthState>("/auth/me"),
    staleTime: 60_000,
    retry: false,
  });
}

export function useRefreshAuth() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["auth"] });
}

/** Signs out everywhere in the app when the server says the session is gone. */
export function useUnauthorizedListener() {
  const qc = useQueryClient();
  useEffect(() => {
    const h = () => void qc.invalidateQueries({ queryKey: ["auth"] });
    window.addEventListener("akab:unauthorized", h);
    return () => window.removeEventListener("akab:unauthorized", h);
  }, [qc]);
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  useEffect(() => {
    if (me.locale && me.locale !== currentLocale()) setLocale(me.locale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.id]);
  return <SessionCtx.Provider value={me}>{children}</SessionCtx.Provider>;
}

export function useMe(): Me {
  const me = useContext(SessionCtx);
  if (!me) throw new Error("useMe outside SessionProvider");
  return me;
}

export function useCan() {
  const me = useMe();
  return (...keys: PermissionKey[]) => keys.some((k) => me.permissions.includes(k));
}

export async function signOut(qc: ReturnType<typeof useQueryClient>) {
  await api.post("/auth/logout").catch(() => undefined);
  qc.clear();
  await qc.invalidateQueries({ queryKey: ["auth"] });
}
