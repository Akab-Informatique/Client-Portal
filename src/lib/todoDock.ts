import { useSyncExternalStore } from "react";

/** The to-do tasks put away in the drawer (minimized), kept for the browser tab. A to-do with a running timer shows there too. */
export type DockedTodo = { id: string; title: string };
const KEY = "akab.todos.dock";
let list: DockedTodo[] = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as DockedTodo[];
  } catch {
    return [];
  }
})();
const listeners = new Set<() => void>();
const save = (next: DockedTodo[]) => {
  list = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* the dock works without it */
  }
  listeners.forEach((l) => l());
};
export const todoDock = {
  add: (t: DockedTodo) => save([...list.filter((x) => x.id !== t.id), t].slice(-8)),
  remove: (id: string) => save(list.filter((x) => x.id !== id)),
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useDockedTodos = () => useSyncExternalStore(subscribe, () => list);
