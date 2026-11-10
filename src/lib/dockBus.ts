import { useSyncExternalStore } from "react";

/**
 * A small bridge between the docks: the drawer of minimized tickets (which owns the screen's drawer) and the minimized
 * project tasks and to-dos (which show in that same drawer, each with its own look). They say how many they hold and whether
 * a timer runs, and draw their cells into the drawer's slot.
 */
type State = { projects: number; projectRunning: boolean; todos: number; todoRunning: boolean; slot: HTMLElement | null };
let state: State = { projects: 0, projectRunning: false, todos: 0, todoRunning: false, slot: null };
const listeners = new Set<() => void>();
export const dockBus = {
  set(next: Partial<State>) {
    const merged = { ...state, ...next };
    if (merged.projects === state.projects && merged.projectRunning === state.projectRunning && merged.todos === state.todos && merged.todoRunning === state.todoRunning && merged.slot === state.slot) return;
    state = merged;
    listeners.forEach((l) => l());
  },
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useDockBus = () => useSyncExternalStore(subscribe, () => state);
