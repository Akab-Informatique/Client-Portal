import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, Loader2, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";

type Card = { id: string; title: string; category: string; tags: string[]; published: boolean; excerpt: string; author: string | null; mine: boolean; createdAt: string; updatedAt: string };
type Article = { id: string; title: string; category: string; body: string; tags: string[]; published: boolean; author: string | null; mine: boolean; createdAt: string; updatedAt: string };
type Filter = "all" | "mine";

/** Documentation › Base de connaissances: articles the team writes and reads (a draft is its author's until published) */
export function KnowledgeBase() {
  const { t } = useTranslation();
  const can = useCan();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | "new" | null>(null);
  const { data = [], isLoading } = useQuery({ queryKey: ["kb"], queryFn: () => api.get<Card[]>("/kb") });
  const edit = can("kb.edit");
  const categories = useMemo(() => [...new Set(data.map((a) => a.category).filter(Boolean))].sort((x, y) => x.localeCompare(y)), [data]);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return data.filter((a) => (!category || a.category === category) && (filter === "all" || a.mine) && words.every((w) => `${a.title} ${a.category} ${a.tags.join(" ")} ${a.excerpt}`.toLowerCase().includes(w)));
  }, [data, q, category, filter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("documentation.kb.search")} className="pl-8" />
        </div>
        {edit && (
          <Button size="sm" variant={filter === "mine" ? "secondary" : "ghost"} onClick={() => setFilter(filter === "mine" ? "all" : "mine")}>
            {t("documentation.kb.mine")}
          </Button>
        )}
        {edit && (
          <Button className="ml-auto" onClick={() => setOpen("new")}>
            <Plus className="size-4" /> {t("documentation.kb.new")}
          </Button>
        )}
      </div>
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {["", ...categories].map((c) => (
            <button key={c || "all"} type="button" aria-pressed={category === c} onClick={() => setCategory(c)} className={cn("rounded-full border px-3 py-1 text-xs", category === c ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10 font-medium text-primary" : "text-muted-foreground hover:text-foreground")}>
              {c || t("documentation.kb.allCategories")}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <Loader2 className="mx-auto mt-12 size-6 animate-spin text-muted-foreground" />
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <BookOpen className="mx-auto mb-3 size-9 text-muted-foreground" />
          <p className="font-medium">{t("documentation.kb.none")}</p>
          {edit && <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t("documentation.kb.noneHint")}</p>}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((a) => (
            <button key={a.id} type="button" onClick={() => setOpen(a.id)} className="rounded-xl border bg-card/60 p-4 text-left backdrop-blur transition hover:border-primary/60">
              <div className="flex items-start justify-between gap-2">
                <h3 className="line-clamp-2 font-semibold leading-snug">{a.title}</h3>
                {!a.published && <Badge variant="secondary" className="shrink-0">{t("documentation.kb.draft")}</Badge>}
              </div>
              {a.category && <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-primary/80">{a.category}</p>}
              <p className="mt-1.5 line-clamp-3 text-sm text-muted-foreground">{a.excerpt || "—"}</p>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {[a.author, relativeTime(a.updatedAt)].filter(Boolean).join(" · ")}
              </p>
            </button>
          ))}
        </div>
      )}
      {open && <ArticleDialog id={open === "new" ? null : open} categories={categories} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ArticleDialog({ id, categories, onClose }: { id: string | null; categories: string[]; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const can = useCan();
  const { data, isLoading } = useQuery({ queryKey: ["kb", id], enabled: Boolean(id), queryFn: () => api.get<Article>(`/kb/${id}`) });
  const [editing, setEditing] = useState(id === null);
  const [f, setF] = useState<{ title: string; category: string; body: string; tags: string; published: boolean } | null>(id === null ? { title: "", category: "", body: "", tags: "", published: false } : null);
  const form = f ?? (data ? { title: data.title, category: data.category, body: data.body, tags: data.tags.join(", "), published: data.published } : null);
  const mayChange = data ? (data.mine || can("kb.manage")) && can("kb.edit") : true;
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["kb"] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => {
      const body = { title: form!.title.trim(), category: form!.category.trim(), body: form!.body, tags: form!.tags.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 10), published: form!.published };
      return id ? api.patch(`/kb/${id}`, body) : api.post("/kb", body);
    },
    onSuccess: () => {
      toast.success(t("documentation.kb.saved"));
      done();
    },
    onError: () => toast.error(t("common.error")),
  });
  const del = useMutation({ mutationFn: () => api.del(`/kb/${id}`), onSuccess: done, onError: () => toast.error(t("common.error")) });
  const remove = async () => {
    if (await confirm({ title: t("documentation.kb.deleteTitle", { name: data?.title ?? "" }), description: t("documentation.kb.deleteText"), confirmLabel: t("common.delete"), destructive: true })) del.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="size-5 text-primary" /> {editing ? t(id ? "documentation.kb.edit" : "documentation.kb.new") : (data?.title ?? "…")}
          </DialogTitle>
          {!editing && data && (
            <DialogDescription>
              {[data.category, data.author, relativeTime(data.updatedAt), !data.published && t("documentation.kb.draft")].filter(Boolean).join(" · ")}
            </DialogDescription>
          )}
        </DialogHeader>
        {id && isLoading && <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />}
        {form && editing && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("documentation.kb.title")}</Label>
              <Input value={form.title} maxLength={200} onChange={(e) => setF({ ...form, title: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("documentation.kb.category")}</Label>
                <Input list="kb-categories" value={form.category} maxLength={60} onChange={(e) => setF({ ...form, category: e.target.value })} />
                <datalist id="kb-categories">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("documentation.kb.tags")}</Label>
                <Input value={form.tags} onChange={(e) => setF({ ...form, tags: e.target.value })} placeholder={t("documentation.kb.tagsHint")} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("documentation.kb.body")}</Label>
              <Textarea rows={14} value={form.body} maxLength={60000} onChange={(e) => setF({ ...form, body: e.target.value })} placeholder={t("documentation.kb.bodyHint")} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={form.published} onCheckedChange={(v) => setF({ ...form, published: v })} /> {t("documentation.kb.publish")}
              <span className="text-xs text-muted-foreground">{t(form.published ? "documentation.kb.publishedHint" : "documentation.kb.draftHint")}</span>
            </label>
          </div>
        )}
        {data && !editing && (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{data.body || "—"}</p>
            {data.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {data.tags.map((x) => (
                  <Badge key={x} variant="secondary">
                    {x}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {!editing && data && mayChange && (
              <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void remove()} disabled={del.isPending}>
                <Trash2 className="size-4" /> {t("common.delete")}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t(editing ? "common.cancel" : "common.close")}
            </Button>
            {editing ? (
              <Button disabled={!form?.title.trim() || save.isPending} onClick={() => save.mutate()}>
                {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
              </Button>
            ) : (
              mayChange && (
                <Button onClick={() => setEditing(true)}>
                  <Pencil className="size-4" /> {t("documentation.kb.edit")}
                </Button>
              )
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
