import { createContext, useContext } from "react";
import type { DragEndEvent } from "@dnd-kit/core";

/**
 * Dragging tasks in the phases of a project: one drag area for all of them (so a task can go from a phase to another);
 * each phase registers how it handles a drop inside itself, and says whether a task is being dragged.
 */
export type TaskDnd = { register: (milestoneId: string, fn: (e: DragEndEvent) => void) => () => void; dragging: boolean };
export const TaskDndCtx = createContext<TaskDnd>({ register: () => () => undefined, dragging: false });
export const useTaskDnd = () => useContext(TaskDndCtx);
