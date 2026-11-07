import { useSyncExternalStore } from "react";

/**
 * A small bridge between the two docks: the drawer of minimized tickets (which owns the screen's drawer) and the
 * minimized project tasks (which show in that same drawer, marked as projects). The project side says how many it holds
 * and whether a timer runs, and draws its cells into the drawer's slot.
 */
type State = { projects: number; projectRunning: boolean; slot: HTMLElement | null };
let state: State = { projects: 0, projectRunning: false, slot: null };
const listeners = new Set<() => void>();
export const dockBus = {
  set(next: Partial<State>) {
    const merged = { ...state, ...next };
    if (merged.projects === state.projects && merged.projectRunning === state.projectRunning && merged.slot === state.slot) return;
    state = merged;
    listeners.forEach((l) => l());
  },
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useDockBus = () => useSyncExternalStore(subscribe, () => state);
