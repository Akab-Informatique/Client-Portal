import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MessageSquareText, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";

type Point = { id: string; text: string; details: string | null; doneAt: string | null; authorName: string; createdAt: string };

/** Details made only of bullet lines ("- …"): shown as a list */
const bulletsOf = (details: string | null) => {
  const lines = (details ?? "").split("\n").filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => l.startsWith("- ")) ? lines.map((l) => l.slice(2)) : null;
};

/** Weekly meeting: points to discuss with the team, checked off once settled. */
export function PointsSection() {
  const { t } = useTranslation();
  const manage = useCan()("meetings.manage");
  const [text, setText] = useState("");
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["meetings", "points"],
    queryFn: () => api.get<Point[]>("/meetings/points"),
    refetchInterval: 10_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["meetings", "points"] });
  const onError = () => toast.error(t("common.error"));
  const add = useMutation({
    mutationFn: (v: string) => api.post("/meetings/points", { text: v }),
    onSuccess: () => {
      setText("");
      void refresh();
    },
    onError,
  });
  const toggle = useMutation({ mutationFn: (p: Point) => api.patch(`/meetings/points/${p.id}`, { done: !p.doneAt }), onSuccess: refresh, onError });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/meetings/points/${id}`), onSuccess: refresh, onError });

  const open = (data ?? []).filter((p) => !p.doneAt);
  const points = [...open, ...(data ?? []).filter((p) => p.doneAt)];

  return (
    <section className="space-y-3">
      <h2 className="flex h-8 items-center gap-2 text-lg font-semibold">
        <MessageSquareText className="size-5 text-primary" /> {t("meetings.points.title")}
        {data && <span className="text-sm font-normal text-muted-foreground">({open.length})</span>}
      </h2>
      <div className="overflow-hidden rounded-2xl border bg-card/80">
        {manage && (
          <form
            className="flex gap-2 border-b p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) add.mutate(text.trim());
            }}
          >
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
          <ul className="max-h-[30rem] divide-y overflow-y-auto">
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
                  <p className={cn("whitespace-pre-wrap text-sm", p.doneAt && "line-through")}>{p.text}</p>
                  {p.details && <Details details={p.details} />}
                  <p className="text-xs text-muted-foreground">{p.authorName}</p>
                </div>
                {manage && (
                  <button
                    type="button"
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={t("common.delete")}
                    onClick={() => remove.mutate(p.id)}
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Details of points added before the fast field only (a description or bullets) */
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
