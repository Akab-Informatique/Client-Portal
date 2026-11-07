import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ImageOff, ListChecks, Loader2, MonitorUp, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { RecorderDialog } from "./RecorderDialog";
import { SopEditor } from "./SopEditor";
import { coverUrl, type SopCard } from "./shared";

type Filter = "all" | "published" | "mine";

/** Procedures (SOP): step-by-step guides the team makes by recording a screen */
export function SopsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const open = params.get("sop");
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [recording, setRecording] = useState(false);
  const [blank, setBlank] = useState(false);
  const [blankTitle, setBlankTitle] = useState("");
  const edit = can("sops.edit");
  const { data = [], isLoading } = useQuery({ queryKey: ["sops"], queryFn: () => api.get<SopCard[]>("/sops") });
  const show = (id: string | null) => setParams(id ? { sop: id } : {}, { replace: false });

  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return data.filter((s) => (filter === "all" || (filter === "published" ? s.status === "published" : s.mine)) && words.every((w) => `${s.title} ${s.description} ${s.author ?? ""}`.toLowerCase().includes(w)));
  }, [data, q, filter]);

  const create = useMutation({
    mutationFn: () => api.post<SopCard>("/sops", { title: blankTitle.trim() }),
    onSuccess: (s) => {
      setBlank(false);
      setBlankTitle("");
      void qc.invalidateQueries({ queryKey: ["sops"] });
      show(s.id);
    },
    onError: () => toast.error(t("common.error")),
  });

  if (open) return <SopEditor id={open} onBack={() => show(null)} />;

  return (
    <div className="relative isolate space-y-5">
      {!embedded && <GlassBackdrop className="-inset-x-8 -top-6" />}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          {embedded ? (
            <p className="max-w-2xl text-sm text-muted-foreground">{t("sops.subtitle")}</p>
          ) : (
            <>
              <h1 className="flex items-center gap-2 text-2xl font-bold">
                <ListChecks className="size-6 text-primary" /> {t("sops.title")}
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("sops.subtitle")}</p>
            </>
          )}
        </div>
        {edit && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setBlank(true)}>
              <Plus className="size-4" /> {t("sops.blank")}
            </Button>
            <Button onClick={() => setRecording(true)}>
              <MonitorUp className="size-4" /> {t("sops.record")}
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("sops.search")} className="pl-8" />
        </div>
        {(["all", "published", ...(edit ? ["mine"] : [])] as Filter[]).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? "secondary" : "ghost"} onClick={() => setFilter(f)}>
            {t(`sops.filter.${f}`)}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <Loader2 className="mx-auto mt-16 size-6 animate-spin text-muted-foreground" />
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <ListChecks className="mx-auto mb-3 size-9 text-muted-foreground" />
          <p className="font-medium">{t("sops.none")}</p>
          {edit && <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t("sops.noneHint")}</p>}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((s) => {
            const cover = coverUrl(s);
            return (
              <button key={s.id} type="button" onClick={() => show(s.id)} className={cn("group overflow-hidden rounded-xl border bg-card/60 text-left backdrop-blur transition hover:border-primary/60 hover:shadow-lg")}>
                <div className="aspect-video w-full overflow-hidden bg-muted/40">
                  {cover ? <img src={cover} alt="" loading="lazy" className="size-full object-cover object-top transition group-hover:scale-[1.02]" /> : <div className="grid size-full place-items-center text-muted-foreground"><ImageOff className="size-7" /></div>}
                </div>
                <div className="space-y-1.5 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="line-clamp-2 font-semibold leading-snug">{s.title}</h2>
                    <Badge variant={s.status === "published" ? "default" : "secondary"} className="shrink-0">
                      {t(`sops.status.${s.status}`)}
                    </Badge>
                  </div>
                  {s.description && <p className="line-clamp-2 text-xs text-muted-foreground">{s.description}</p>}
                  <p className="text-[11px] text-muted-foreground">
                    {t("sops.doc.stepCount", { count: s.stepCount })} · {s.author ?? "—"} · {relativeTime(s.updatedAt)}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <RecorderDialog
        open={recording}
        onClose={() => setRecording(false)}
        onDone={(id) => {
          setRecording(false);
          void qc.invalidateQueries({ queryKey: ["sops"] });
          show(id);
        }}
      />

      <Dialog open={blank} onOpenChange={setBlank}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("sops.blank")}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (blankTitle.trim()) create.mutate();
            }}
          >
            <Input autoFocus value={blankTitle} maxLength={200} onChange={(e) => setBlankTitle(e.target.value)} placeholder={t("sops.rec.namePlaceholder")} />
            <p className="text-xs text-muted-foreground">{t("sops.blankHint")}</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setBlank(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!blankTitle.trim() || create.isPending}>
                {t("common.create")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
