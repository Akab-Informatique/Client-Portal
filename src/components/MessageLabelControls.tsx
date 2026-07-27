import { useState } from "react";
import { Check, Mail, MailOpen, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MESSAGE_LABEL_PRESETS, type MessageReadStatus } from "@/lib/types";
import { useLocale } from "@/hooks/use-locale";
import { cn } from "@/lib/utils";

interface MessageLabelControlsProps {
  readStatus: MessageReadStatus;
  customLabel: string | null;
  busy?: boolean;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  onSetLabel: (label: string | null) => void;
  className?: string;
}

export function MessageLabelControls({
  readStatus,
  customLabel,
  busy,
  onMarkRead,
  onMarkUnread,
  onSetLabel,
  className,
}: MessageLabelControlsProps) {
  const { t } = useLocale();
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState(customLabel ?? "");

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {readStatus === "unread" ? (
        <Badge className="bg-primary text-primary-foreground hover:bg-primary">
          {t("board.unread")}
        </Badge>
      ) : (
        <Badge variant="outline" className="text-muted-foreground">
          {t("board.read")}
        </Badge>
      )}
      {customLabel && (
        <Badge
          variant="outline"
          className="gap-1 border-primary/40 bg-primary/10 text-primary"
        >
          <Tag className="size-3" />
          {customLabel}
        </Badge>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {readStatus === "unread" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onMarkRead}
            className="h-8"
          >
            <MailOpen className="size-3.5" />
            {t("board.markRead")}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onMarkUnread}
            className="h-8"
          >
            <Mail className="size-3.5" />
            {t("board.markUnread")}
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              className="h-8"
            >
              <Tag className="size-3.5" />
              {t("board.label")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuLabel>{t("board.label")}</DropdownMenuLabel>
            {MESSAGE_LABEL_PRESETS.map((label) => (
              <DropdownMenuItem
                key={label}
                onClick={() => onSetLabel(label)}
                className="gap-2"
              >
                {customLabel === label && (
                  <Check className="size-3.5 text-primary" />
                )}
                {customLabel !== label && <span className="size-3.5" />}
                {label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setDraft(customLabel ?? "");
                setCustomOpen(true);
              }}
            >
              {t("board.label")}…
            </DropdownMenuItem>
            {customLabel && (
              <DropdownMenuItem
                onClick={() => onSetLabel(null)}
                className="text-destructive focus:text-destructive"
              >
                <X className="size-3.5" />
                {t("common.delete")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {customOpen && (
        <form
          className="flex w-full max-w-sm items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSetLabel(draft.trim() || null);
            setCustomOpen(false);
          }}
        >
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="…"
            maxLength={40}
            className="h-8"
          />
          <Button
            type="submit"
            size="sm"
            className="h-8 shrink-0"
            disabled={busy}
          >
            {t("common.save")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 shrink-0"
            onClick={() => setCustomOpen(false)}
          >
            {t("common.cancel")}
          </Button>
        </form>
      )}
    </div>
  );
}
