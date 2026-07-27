import { Bell, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

interface InAppToastProps {
  title: string;
  body: string;
  onDismiss: () => void;
  href?: string;
}

export function InAppToast({ title, body, onDismiss, href = "/client/board" }: InAppToastProps) {
  return (
    <div className="pointer-events-auto fixed bottom-4 right-4 z-[60] w-[min(100vw-2rem,22rem)] animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="rounded-xl border border-primary/40 bg-card shadow-2xl shadow-black/30">
        <div className="flex items-start gap-3 p-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Bell className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              New board message
            </p>
            <p className="mt-0.5 truncate font-semibold">{title}</p>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{body}</p>
            <div className="mt-3 flex gap-2">
              <Button asChild size="sm">
                <Link to={href} onClick={onDismiss}>
                  Open board
                </Link>
              </Button>
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                Dismiss
              </Button>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onDismiss}
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
