import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ListPlus, MessageSquareText, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";

type Point = {
  id: string;
  text: string;
  details: string | null;
  doneAt: string | null;
  authorName: string;
  createdAt: string;
};
type Draft = { text: string; details: string | null };

const BULLET = "- ";
/** Details made only of bullet lines ("- …"): shown as a list */
const bulletsOf = (details: string | null) => {
  const lines = (details ?? "").split("\n").filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => l.startsWith(BULLET)) ? lines.map((l) => l.slice(BULLET.length)) : null;
};

/** Weekly meeting: points to discuss with the team, checked off once settled. */
export function PointsSection() {
  const { t } = useTranslation();
  const manage = useCan()("meetings.manage");
  const [text, setText] = useState("");
  /** The detailed editor: a new point (no id) or an existing one */
  const [editing, setEditing] = useState<(Draft & { id?: string }) | null>(null);
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["meetings", "points"],
    queryFn: () => api.get<Point[]>("/meetings/points"),
    refetchInterval: 10_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["meetings", "points"] });
  const onError = () => toast.error(t("common.error"));
  const add = useMutation({
    mutationFn: (v: Draft) => api.post("/meetings/points", v),
    onSuccess: () => {
      setText("");
      setEditing(null);
      void refresh();
    },
    onError,
  });
  const save = useMutation({
    mutationFn: ({ id, ...v }: Draft & { id: string }) => api.patch(`/meetings/points/${id}`, v),
    onSuccess: () => {
      setEditing(null);
      void refresh();
    },
    onError,
  });
  const toggle = useMutation({
    mutationFn: (p: Point) => api.patch(`/meetings/points/${p.id}`, { done: !p.doneAt }),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/meetings/points/${id}`),
    onSuccess: refresh,
    onError,
  });

  const open = (data ?? []).filter((p) => !p.doneAt);
  const points = [...open, ...(data ?? []).filter((p) => p.doneAt)];

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <MessageSquareText className="size-5 text-primary" /> {t("meetings.points.title")}
        {data && <span className="text-sm font-normal text-muted-foreground">({open.length})</span>}
      </h2>
      <div className="overflow-hidden rounded-2xl border bg-card/80">
        {manage && (
          <form
            className="flex gap-2 border-b p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) add.mutate({ text: text.trim(), details: null });
            }}
          >
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0"
              title={t("meetings.points.detailed")}
              aria-label={t("meetings.points.detailed")}
              onClick={() => setEditing({ text: text.trim(), details: null })}
            >
              <ListPlus className="size-4" />
            </Button>
            <Input maxLength={2000} placeholder={t("meetings.points.placeholder")} value={text} onChange={(e) => setText(e.target.value)} />
            <Button type="submit" disabled={!text.trim() || add.isPending}>
              <Plus className="size-4" /> {t("meetings.points.add")}
            </Button>
          </form>
        )}
        {isLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : isError ? (
          <p className="p-6 text-center text-muted-foreground">{t("common.error")}</p>
        ) : points.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("meetings.points.empty")}</p>
        ) : (
          <ul className="divide-y">
            {points.map((p) => (
              <li key={p.id} className="group flex items-start gap-3 px-4 py-2.5">
                <Checkbox
                  className="mt-0.5"
                  checked={Boolean(p.doneAt)}
                  disabled={!manage}
                  onCheckedChange={() => toggle.mutate(p)}
                  aria-label={t(p.doneAt ? "meetings.points.reopen" : "meetings.points.markDone")}
                />
                <div className={cn("min-w-0 flex-1", p.doneAt && "text-muted-foreground")}>
                  <p className={cn("whitespace-pre-wrap text-sm", p.details && "font-medium", p.doneAt && "line-through")}>{p.text}</p>
                  {p.details && <Details details={p.details} />}
                  <p className="text-xs text-muted-foreground">{p.authorName}</p>
                </div>
                {manage && (
                  <div className="flex gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={t("common.edit")}
                      onClick={() =>
                        setEditing({
                          id: p.id,
                          text: p.text,
                          details: p.details,
                        })
                      }
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-red-400"
                      aria-label={t("common.delete")}
                      onClick={() => remove.mutate(p.id)}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing && (
        <PointDialog
          initial={editing}
          pending={add.isPending || save.isPending}
          onClose={() => setEditing(null)}
          onSave={(v) => (editing.id ? save.mutate({ id: editing.id, ...v }) : add.mutate(v))}
        />
      )}
    </section>
  );
}

function Details({ details }: { details: string }) {
  const bullets = bulletsOf(details);
  if (bullets) {
    return (
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
        {bullets.map((b, i) => (
          <li key={i} className="whitespace-pre-wrap">
            {b}
          </li>
        ))}
      </ul>
    );
  }
  return <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{details}</p>;
}

/** A point with a title and detail bullet points. */
function PointDialog({
  initial,
  pending,
  onClose,
  onSave,
}: {
  initial: Draft & { id?: string };
  pending: boolean;
  onClose: () => void;
  onSave: (v: Draft) => void;
}) {
  const { t } = useTranslation();
  // free text (if any): one bullet per line
  const startBullets = (initial.details ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*[-•*]\s*/, "").trim())
    .filter(Boolean);
  const [title, setTitle] = useState(initial.text);
  const [bullets, setBullets] = useState<string[]>(startBullets.length ? startBullets : [""]);
  const rows = useRef<(HTMLInputElement | null)[]>([]);

  const details = bullets
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => BULLET + b)
    .join("\n");
  const focusRow = (i: number) => requestAnimationFrame(() => rows.current[i]?.focus());

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(initial.id ? "meetings.points.editTitle" : "meetings.points.detailed")}</DialogTitle>
          <DialogDescription>{t("meetings.points.detailedHint")}</DialogDescription>
        </DialogHeader>
        <form
          id="meeting-point"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) onSave({ text: title.trim(), details: details || null });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="point-title">{t("meetings.points.titleLabel")}</Label>
            <Input id="point-title" autoFocus maxLength={2000} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("meetings.points.bullets")}</Label>
            <div className="space-y-1.5">
              {bullets.map((b, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-muted-foreground">•</span>
                  <Input
                    ref={(el) => {
                      rows.current[i] = el;
                    }}
                    value={b}
                    maxLength={500}
                    onChange={(e) => setBullets(bullets.map((x, j) => (j === i ? e.target.value : x)))}
                    onKeyDown={(e) => {
                      // Enter: a new bullet right after this one
                      if (e.key === "Enter") {
                        e.preventDefault();
                        setBullets([...bullets.slice(0, i + 1), "", ...bullets.slice(i + 1)]);
                        focusRow(i + 1);
                      }
                      // Backspace on an empty bullet: remove it
                      if (e.key === "Backspace" && !b && bullets.length > 1) {
                        e.preventDefault();
                        setBullets(bullets.filter((_, j) => j !== i));
                        focusRow(Math.max(0, i - 1));
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-red-400 disabled:opacity-30"
                    aria-label={t("common.delete")}
                    disabled={bullets.length === 1}
                    onClick={() => setBullets(bullets.filter((_, j) => j !== i))}
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setBullets([...bullets, ""]);
                  focusRow(bullets.length);
                }}
              >
                <Plus className="size-4" /> {t("meetings.points.addBullet")}
              </Button>
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="meeting-point" disabled={!title.trim() || details.length > 8000 || pending}>
            {t(initial.id ? "common.save" : "meetings.points.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
