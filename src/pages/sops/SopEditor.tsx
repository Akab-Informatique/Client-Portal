import { useEffect, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowLeft, ArrowUp, Eraser, EyeOff, FileText, ImagePlus, Loader2, MapPin, MonitorUp, MousePointer2, Plus, Square, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { AiTextarea } from "@/components/AiPolish";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { pixelate, shotFromFile } from "@/lib/sop/image";
import { cn } from "@/lib/utils";
import { RecorderDialog } from "./RecorderDialog";
import { SopActions, SopPrint, SopSheet } from "./SopDocument";
import { StepImage, type Tool } from "./StepImage";
import { addPictureStep, imageBody, imageUrl, stepName, type Mark, type SopDetail, type SopStep } from "./shared";

const keyOf = (id: string) => ["sop", id];

/** A procedure opened: read by everyone who sees it, changed by its author (and managers) */
export function SopEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: sop, isLoading, error } = useQuery({ queryKey: keyOf(id), queryFn: () => api.get<SopDetail>(`/sops/${id}`) });
  const [recording, setRecording] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keyOf(id) });
    void qc.invalidateQueries({ queryKey: ["sops"] });
  };
  const fail = (e: unknown) => toast.error(e instanceof ApiError ? t(`sops.errors.${e.code}`, { defaultValue: t("common.error") }) : t("common.error"));

  const patch = useMutation({ mutationFn: (p: Partial<Pick<SopDetail, "title" | "description" | "status">>) => api.patch(`/sops/${id}`, p), onSuccess: refresh, onError: fail });
  const remove = useMutation({
    mutationFn: () => api.del(`/sops/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sops"] });
      onBack();
    },
    onError: fail,
  });
  const reorder = useMutation({ mutationFn: (ids: string[]) => api.put(`/sops/${id}/steps/order`, { ids }), onSuccess: refresh, onError: fail });
  const addText = useMutation({ mutationFn: (after: string | null) => api.post(`/sops/${id}/steps`, { source: "text", ...(after ? { after } : {}) }), onSuccess: refresh, onError: fail });

  /** Pictures from the clipboard (Win + Shift + S, then paste), from a file or dropped: one step each */
  const addFiles = async (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith("image/"));
    if (!pics.length) return;
    setBusy(true);
    try {
      for (const f of pics) await addPictureStep(id, await shotFromFile(f), f.name ? "upload" : "paste");
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const canEdit = sop?.canEdit ?? false;
  useEffect(() => {
    if (!canEdit) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      void addFiles(files.map((f) => (f.name ? f : new File([f], "", { type: f.type }))));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, id]);

  if (isLoading) return <Loader2 className="mx-auto mt-16 size-6 animate-spin text-muted-foreground" />;
  if (error || !sop) {
    return (
      <div className="space-y-3 py-10 text-center">
        <p className="text-sm text-muted-foreground">{t("sops.notFound")}</p>
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="size-4" /> {t("sops.back")}
        </Button>
      </div>
    );
  }

  const move = (i: number, d: -1 | 1) => {
    const ids = sop.steps.map((s) => s.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    reorder.mutate(ids);
  };
  const drop = (e: DragEvent) => {
    if (!canEdit || !e.dataTransfer.files.length) return;
    e.preventDefault();
    setDropping(false);
    void addFiles(Array.from(e.dataTransfer.files));
  };

  // someone who may only read it: the sheet, with print and download
  if (!canEdit) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="size-4" /> {t("sops.back")}
          </Button>
          <div className="ml-auto flex gap-2">
            <SopActions sop={sop} onPrint={() => setPrinting(true)} />
          </div>
        </div>
        <SopSheet sop={sop} />
        {printing && <SopPrint sop={sop} onClose={() => setPrinting(false)} />}
      </div>
    );
  }

  return (
    <div className={cn("space-y-5", dropping && "rounded-xl outline-dashed outline-2 outline-primary")} onDragOver={(e) => e.dataTransfer.types.includes("Files") && (e.preventDefault(), setDropping(true))} onDragLeave={() => setDropping(false)} onDrop={drop}>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-4" /> {t("sops.back")}
        </Button>
        <Badge variant={sop.status === "published" ? "default" : "secondary"}>{t(`sops.status.${sop.status}`)}</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setRecording(true)}>
            <MonitorUp className="size-4" /> {t("sops.addRecording")}
          </Button>
          <SopActions sop={sop} onPrint={() => setPrinting(true)} />
          <Button onClick={() => patch.mutate({ status: sop.status === "published" ? "draft" : "published" })} disabled={patch.isPending}>
            {sop.status === "published" ? t("sops.unpublish") : t("sops.publish")}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("common.delete")}
            onClick={() => void confirm({ title: t("sops.deleteTitle", { name: sop.title }), description: t("sops.deleteText"), confirmLabel: t("common.delete"), destructive: true }).then((ok) => ok && remove.mutate())}
          >
            <Trash2 className="size-4 text-red-400" />
          </Button>
        </div>
      </div>

      <TitleFields sop={sop} onSave={(p) => patch.mutate(p)} />

      <div className="space-y-5">
        {sop.steps.map((s, i) => (
          <StepCard key={s.id} sopId={id} step={s} index={i} count={sop.steps.length} onMove={(d) => move(i, d)} onChanged={refresh} onAddAfter={() => addText.mutate(s.id)} fail={fail} />
        ))}
      </div>

      {sop.steps.length === 0 && (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <ImagePlus className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="font-medium">{t("sops.emptyTitle")}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t("sops.emptyText")}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => addText.mutate(sop.steps.at(-1)?.id ?? null)}>
          <Plus className="size-4" /> {t("sops.addTextStep")}
        </Button>
        <Button variant="outline" onClick={() => file.current?.click()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} {t("sops.addPicture")}
        </Button>
        <input
          ref={file}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <p className="text-xs text-muted-foreground">{t("sops.pasteHint")}</p>
      </div>

      <RecorderDialog
        open={recording}
        sopId={id}
        sopTitle={sop.title}
        onClose={() => setRecording(false)}
        onDone={() => {
          setRecording(false);
          refresh();
        }}
      />
      {printing && <SopPrint sop={sop} onClose={() => setPrinting(false)} />}
    </div>
  );
}

/** Title and description: saved when the field is left */
function TitleFields({ sop, onSave }: { sop: SopDetail; onSave: (p: { title?: string; description?: string }) => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(sop.title);
  const [description, setDescription] = useState(sop.description);
  useEffect(() => setTitle(sop.title), [sop.title]);
  useEffect(() => setDescription(sop.description), [sop.description]);
  return (
    <div className="space-y-2">
      <Input
        value={title}
        maxLength={200}
        aria-label={t("sops.titleLabel")}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title.trim() && title.trim() !== sop.title && onSave({ title: title.trim() })}
        className="h-12 border-transparent bg-transparent px-1 font-display text-2xl font-bold hover:border-input focus-visible:border-input"
      />
      <AiTextarea value={description} placeholder={t("sops.descriptionPlaceholder")} maxLength={4000} rows={2} onChange={(e) => setDescription(e.target.value)} onBlur={() => description.trim() !== sop.description && onSave({ description: description.trim() })} />
    </div>
  );
}

const TOOLS: { tool: Tool; icon: typeof MapPin; key: string }[] = [
  { tool: "pin", icon: MapPin, key: "pin" },
  { tool: "box", icon: Square, key: "box" },
  { tool: "blur", icon: EyeOff, key: "blur" },
  { tool: "erase", icon: Eraser, key: "erase" },
];

/** One step: its number, title, words, picture (with the tools to point at things and to hide things) and its buttons */
function StepCard({ sopId, step, index, count, onMove, onChanged, onAddAfter, fail }: { sopId: string; step: SopStep; index: number; count: number; onMove: (d: -1 | 1) => void; onChanged: () => void; onAddAfter: () => void; fail: (e: unknown) => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [title, setTitle] = useState(step.title);
  const [description, setDescription] = useState(step.description);
  const [marks, setMarks] = useState<Mark[]>(step.marks);
  const [tool, setTool] = useState<Tool>("view");
  const [working, setWorking] = useState(false);
  useEffect(() => setMarks(step.marks), [step.marks]);
  const save = (p: Record<string, unknown>) => api.patch(`/sops/${sopId}/steps/${step.id}`, p).then(onChanged, fail);
  const setMarksNow = (m: Mark[]) => {
    setMarks(m);
    void save({ marks: m });
  };
  /** Hide an area for good: the picture itself is changed, the original is not kept */
  const blur = async (r: { x: number; y: number; w: number; h: number }) => {
    setWorking(true);
    try {
      const res = await fetch(imageUrl(sopId, step), { credentials: "same-origin" });
      const shot = await pixelate(await res.blob(), r);
      await save({ image: await imageBody(shot) });
      toast.success(t("sops.blurred"));
    } catch (e) {
      fail(e);
    } finally {
      setWorking(false);
    }
  };
  const remove = () => void confirm({ title: t("sops.deleteStepTitle"), confirmLabel: t("common.delete"), destructive: true }).then((ok) => { if (ok) void api.del(`/sops/${sopId}/steps/${step.id}`).then(onChanged, fail); });

  return (
    <section className="rounded-xl border bg-card/60 p-4 backdrop-blur">
      <div className="flex items-start gap-3">
        <span className="mt-1 grid size-9 shrink-0 place-items-center rounded-full bg-[#0a0a0b] text-sm font-bold text-[#ffce1a] ring-1 ring-white/10">{index + 1}</span>
        <div className="min-w-0 flex-1 space-y-2">
          <Input value={title} maxLength={200} placeholder={stepName(step, index, t("sops.step"))} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() !== step.title && void save({ title: title.trim() })} className="font-semibold" />
          <Textarea value={description} maxLength={4000} rows={2} placeholder={t("sops.stepPlaceholder")} onChange={(e) => setDescription(e.target.value)} onBlur={() => description.trim() !== step.description && void save({ description: description.trim() })} />
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <Button variant="ghost" size="icon" className="size-8" disabled={index === 0} onClick={() => onMove(-1)} aria-label={t("sops.up")}>
            <ArrowUp className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={t("sops.down")}>
            <ArrowDown className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={onAddAfter} aria-label={t("sops.addAfter")} title={t("sops.addAfter")}>
            <Plus className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={remove} aria-label={t("common.delete")}>
            <Trash2 className="size-4 text-red-400" />
          </Button>
        </div>
      </div>
      {step.hasImage ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="button" size="sm" variant={tool === "view" ? "secondary" : "ghost"} onClick={() => setTool("view")} title={t("sops.tool.view")}>
              <MousePointer2 className="size-4" />
            </Button>
            {TOOLS.map(({ tool: k, icon: Icon, key }) => (
              <Button key={k} type="button" size="sm" variant={tool === k ? "secondary" : "ghost"} onClick={() => setTool(tool === k ? "view" : k)} title={t(`sops.tool.${key}Hint`)}>
                <Icon className="size-4" /> <span className="hidden sm:inline">{t(`sops.tool.${key}`)}</span>
              </Button>
            ))}
            {working && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            <span className="ml-auto text-xs text-muted-foreground">{tool === "view" ? "" : t(`sops.tool.${tool}Hint`)}</span>
          </div>
          <StepImage src={imageUrl(sopId, step)} marks={marks} tool={tool} onMarks={setMarksNow} onBlur={(r) => void blur(r)} />
        </div>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <FileText className="size-3.5" /> {t("sops.textOnly")}
        </p>
      )}
    </section>
  );
}
