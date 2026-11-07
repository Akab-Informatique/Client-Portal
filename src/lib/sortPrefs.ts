import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";

/**
 * The sort a list opens on, chosen by each technician for each view and kept on their account (it follows them
 * to any computer). Nothing chosen = the default of the view, the checkpoint.
 */
export function useSortDefault<T extends string>(view: string, fallback: T, allowed?: readonly T[]): [T, (v: T | null) => void] {
  const me = useMe();
  const qc = useQueryClient();
  const saved = me.preferences.sortDefaults?.[view];
  const value = (saved && (!allowed || (allowed as readonly string[]).includes(saved)) ? saved : fallback) as T;
  const set = useCallback(
    (v: T | null) => {
      void api.put("/me/preferences", { sortDefaults: { [view]: v } }).then(() => qc.invalidateQueries({ queryKey: ["auth"] }));
    },
    [view, qc],
  );
  return [value, set];
}

/** The order the person put the items of a list in by hand ("custom" sort): keys, first to last. Their own, nobody else's. */
export function useCustomOrder(scope: string, enabled = true) {
  const qc = useQueryClient();
  const key = ["sort-order", scope];
  const { data } = useQuery({ queryKey: key, enabled, queryFn: () => api.get<{ keys: string[] }>(`/me/sort-order?scope=${encodeURIComponent(scope)}`), staleTime: 60_000 });
  const save = useCallback(
    (keys: string[]) => {
      qc.setQueryData(key, { keys });
      void api.put("/me/sort-order", { scope, keys }).catch(() => qc.invalidateQueries({ queryKey: key }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, qc],
  );
  return { keys: data?.keys ?? [], save };
}

/** Sort items by a custom order: the ones in the saved order first, the others after in their current order */
export function byCustom<T>(items: T[], keyOf: (x: T) => string, order: string[]): T[] {
  const at = new Map(order.map((k, i) => [k, i]));
  return [...items].sort((a, b) => (at.get(keyOf(a)) ?? 1e9) - (at.get(keyOf(b)) ?? 1e9));
}
