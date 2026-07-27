import { createContext, useContext, type ReactNode } from "react";
import { useBoardNotifications } from "@/hooks/use-board-notifications";

type BoardNotificationsValue = ReturnType<typeof useBoardNotifications>;

const BoardNotificationsContext = createContext<BoardNotificationsValue | null>(
  null,
);

export function BoardNotificationsProvider({ children }: { children: ReactNode }) {
  const value = useBoardNotifications();
  return (
    <BoardNotificationsContext.Provider value={value}>
      {children}
    </BoardNotificationsContext.Provider>
  );
}

export function useBoardNotificationsContext() {
  const ctx = useContext(BoardNotificationsContext);
  if (!ctx) {
    throw new Error(
      "useBoardNotificationsContext must be used within BoardNotificationsProvider",
    );
  }
  return ctx;
}

