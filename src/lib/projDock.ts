import { useSyncExternalStore } from "react";

/**
 * New-format projects minimized from their window: they wait in the drawer of minimized items (the same one as the
 * tickets) and reopen in the Tickets list. Kept for the browser tab.
 */
export type DockedProj = { id: string; number: string; name: string };
const KEY = "akab.proj.dock";

function read(): DockedProj[] {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as DockedProj[];
  } catch {
    return [];
  }
}
let state: DockedProj[] = read();
const listeners = new Set<() => void>();
const set = (next: DockedProj[]) => {
  state = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* the drawer works without it */
  }
  listeners.forEach((l) => l());
};

export const projDock = {
  add: (p: DockedProj) => set([...state.filter((x) => x.id !== p.id), p].slice(-6)),
  remove: (id: string) => set(state.filter((x) => x.id !== id)),
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useProjDock = () => useSyncExternalStore(subscribe, () => state);
