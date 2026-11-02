import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AppWindow, Camera, CheckCircle2, Clapperboard, Download, Loader2, MonitorUp, Pause, Play, Square, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api";
import { makeMontage } from "@/lib/sop/montage";
import { floatingSupported, openFloating, ScreenRecorder, type Floating } from "@/lib/sop/recorder";
import { addPictureStep, fileName, saveAs, type SopCard } from "./shared";

type Phase = "setup" | "recording" | "saving" | "done";

/**
 * Records the screen and turns it into the steps of a procedure. New procedure (`sopId` empty: it asks for a title)
 * or more steps for one that exists. The browser asks which screen, window or tab to record; a small window above
 * every other application takes the steps while the person works.
 */
export function RecorderDialog({ open, sopId, sopTitle, onClose, onDone }: { open: boolean; sopId?: string; sopTitle?: string; onClose: () => void; onDone: (sopId: string) => void }) {
  const { t } = useTranslation();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [phase, setPhase] = useState<Phase>("setup");
  const [title, setTitle] = useState("");
  const [auto, setAuto] = useState(true);
  const [video, setVideo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [videoFile, setVideoFile] = useState<Blob | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // the automatic edit of the video: progress (0–1) while it is made, then the finished file
  const [montage, setMontage] = useState<number | null>(null);
  const [edited, setEdited] = useState<{ blob: Blob; url: string } | null>(null);
  const montageAbort = useRef<AbortController | null>(null);
  // what already reached the server, so a second try goes on where the first stopped (never twice the same step)
  const created = useRef<{ id: string | null; sent: number }>({ id: null, sent: 0 });
  const rec = useRef<ScreenRecorder | null>(null);
  const float = useRef<Floating | null>(null);
  const finishing = useRef(false);
  const [floatOpen, setFloatOpen] = useState(false);

  const closeFloat = useCallback(() => {
    float.current?.close();
    float.current = null;
    setFloatOpen(false);
  }, []);

  const labels = useCallback(
    () => ({
      capture: t("sops.rec.float.capture"),
      pause: t("sops.rec.pause"),
      resume: t("sops.rec.resume"),
      stop: t("sops.rec.finish"),
      auto: t("sops.rec.float.auto"),
      steps: (n: number) => t("sops.rec.float.steps", { count: n }),
      taken: (n: number) => t("sops.rec.float.taken", { count: n }),
      paused: t("sops.rec.float.paused"),
      hint: t("sops.rec.float.hint"),
    }),
    [t],
  );

  const reset = useCallback(() => {
    closeFloat();
    void rec.current?.stop();
    rec.current?.dispose();
    rec.current = null;
    finishing.current = false;
    setPhase("setup");
    setError(null);
    setProgress(0);
    setVideoFile(null);
    setSavedId(null);
    setFailed(false);
    montageAbort.current?.abort();
    setMontage(null);
    setEdited((e) => {
      if (e) URL.revokeObjectURL(e.url);
      return null;
    });
    created.current = { id: null, sent: 0 };
  }, [closeFloat]);

  // closed from outside while recording: stop everything
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);
  useEffect(() => () => reset(), [reset]);

  // leaving the page by mistake would lose the steps not saved yet
  useEffect(() => {
    if (phase !== "recording") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  const finish = useCallback(async () => {
    const r = rec.current;
    if (!r || finishing.current) return;
    finishing.current = true;
    closeFloat();
    const v = await r.stop();
    if (v) setVideoFile(v);
    setFailed(false);
    if (!r.steps.length) {
      setError(t("sops.rec.noSteps"));
      finishing.current = false;
      setPhase("setup");
      return;
    }
    setPhase("saving");
    try {
      let id = sopId ?? created.current.id;
      if (!id) id = (await api.post<SopCard>("/sops", { title: title.trim() })).id;
      created.current.id = id;
      setSavedId(id);
      for (let i = created.current.sent; i < r.steps.length; i++) {
        await addPictureStep(id, r.steps[i].shot, r.steps[i].source);
        created.current.sent = i + 1;
        setProgress(i + 1);
      }
      setPhase("done");
    } catch (e) {
      setError(e instanceof ApiError ? t("sops.errors.save", { code: e.code }) : t("common.error"));
      finishing.current = false;
      setFailed(true);
      setPhase("recording");
    }
  }, [closeFloat, sopId, t, title]);

  const start = async () => {
    setError(null);
    const r = new ScreenRecorder({
      step: () => float.current?.flash(r.steps.length),
      ended: () => void finish(),
      change: () => {
        redraw();
        float.current?.refresh();
      },
    });
    rec.current = r;
    try {
      await r.start({ video, auto });
    } catch (e) {
      rec.current = null;
      // pressing "Cancel" in the browser's picker is not an error
      if (!(e instanceof DOMException && e.name === "NotAllowedError")) setError(t("sops.rec.startFailed"));
      return;
    }
    setPhase("recording");
    void openFloat();
  };

  /** `manual`: the person clicked the button, so a failure is told (the automatic try right after the picker stays quiet) */
  const openFloat = async (manual = false) => {
    const r = rec.current;
    if (!r || float.current) return;
    try {
      const f = await openFloating(r, labels(), { stop: () => void finish(), closed: () => setFloatOpen(false) });
      float.current = f;
      setFloatOpen(!!f);
    } catch {
      // the browser wants a click for this: the button in the window does it
      setFloatOpen(false);
      if (manual) toast.error(t("sops.rec.floatFailed"));
    }
  };

  /** Intro with the logo, the recording, the logo and a thank-you: made here, on this computer */
  const edit = async () => {
    if (!videoFile) return;
    const ctl = new AbortController();
    montageAbort.current = ctl;
    setMontage(0);
    try {
      const blob = await makeMontage(videoFile, { title: (sopTitle || title).trim(), thanks: t("sops.rec.montage.thanks"), site: "akab.ca", onProgress: setMontage, signal: ctl.signal });
      setEdited({ blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) toast.error(t("sops.rec.montage.failed"));
    } finally {
      setMontage(null);
    }
  };

  const r = rec.current;
  const canStart = (sopId || title.trim().length > 0) && ScreenRecorder.supported();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && phase !== "saving" && onClose()}>
      <DialogContent className="max-w-2xl" onInteractOutside={(e) => phase !== "setup" && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MonitorUp className="size-5 text-primary" /> {t("sops.rec.title")}
          </DialogTitle>
          <DialogDescription>{t("sops.rec.subtitle")}</DialogDescription>
        </DialogHeader>

        {phase === "setup" && (
          <div className="space-y-4">
            {!sopId && (
              <div className="space-y-1.5">
                <Label htmlFor="sop-title">{t("sops.rec.name")}</Label>
                <Input id="sop-title" autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder={t("sops.rec.namePlaceholder")} />
              </div>
            )}
            <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <span>
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Zap className="size-4 text-primary" /> {t("sops.rec.auto")}
                </span>
                <span className="block text-xs text-muted-foreground">{t("sops.rec.autoHint")}</span>
              </span>
              <Switch checked={auto} onCheckedChange={setAuto} />
            </label>
            <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <span>
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Camera className="size-4 text-primary" /> {t("sops.rec.video")}
                </span>
                <span className="block text-xs text-muted-foreground">{t("sops.rec.videoHint")}</span>
              </span>
              <Switch checked={video} onCheckedChange={setVideo} />
            </label>
            <ul className="space-y-1 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
              <li>• {t("sops.rec.tip1")}</li>
              <li>• {t("sops.rec.tip2")}</li>
              <li>• {t("sops.rec.tip3")}</li>
              {!floatingSupported() && <li className="text-orange-300">• {t("sops.rec.noFloat")}</li>}
            </ul>
            {!ScreenRecorder.supported() && <p className="text-sm text-red-400">{t("sops.rec.unsupported")}</p>}
            {error && <p className="text-sm text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button onClick={() => void start()} disabled={!canStart}>
                <MonitorUp className="size-4" /> {t("sops.rec.start")}
              </Button>
            </div>
          </div>
        )}

        {phase === "recording" && r && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
              <span className={`size-2.5 rounded-full ${r.paused ? "bg-muted-foreground" : "animate-pulse bg-red-500"}`} />
              <span className="text-sm font-medium">{r.paused ? t("sops.rec.float.paused") : t("sops.rec.running")}</span>
              <span className="text-sm text-muted-foreground">{t("sops.rec.float.steps", { count: r.steps.length })}</span>
              <span className="ml-auto text-xs text-muted-foreground">{r.surface === "monitor" ? t("sops.rec.surface.monitor") : r.surface === "window" ? t("sops.rec.surface.window") : r.surface === "browser" ? t("sops.rec.surface.browser") : ""}</span>
            </div>
            {r.surface === "monitor" && floatOpen && <p className="rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-xs text-orange-200">{t("sops.rec.monitorWarn")}</p>}
            {!failed && (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void r.capture()} disabled={r.paused}>
                <Camera className="size-4" /> {t("sops.rec.capture")}
              </Button>
              <Button variant="outline" onClick={() => r.setPaused(!r.paused)}>
                {r.paused ? <Play className="size-4" /> : <Pause className="size-4" />} {r.paused ? t("sops.rec.resume") : t("sops.rec.pause")}
              </Button>
              {floatingSupported() && !floatOpen && (
                <Button variant="outline" onClick={() => void openFloat(true)}>
                  <AppWindow className="size-4" /> {t("sops.rec.openFloat")}
                </Button>
              )}
              <label className="ml-1 flex items-center gap-2 text-sm">
                <Switch checked={r.auto} onCheckedChange={(v) => r.setAuto(v)} /> {t("sops.rec.float.auto")}
              </label>
              <Button variant="destructive" className="ml-auto" onClick={() => void finish()}>
                <Square className="size-4" /> {t("sops.rec.finish")}
              </Button>
            </div>
            )}
            {error && <p className="text-sm text-red-400">{error}</p>}
            {r.steps.length === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t("sops.rec.empty")}</p>
            ) : (
              <div className="grid max-h-64 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
                {r.steps.map((s, i) => (
                  <div key={s.id} className="group relative overflow-hidden rounded-md border">
                    <img src={s.url} alt="" className="aspect-video w-full object-cover" />
                    <span className="absolute left-1 top-1 grid size-5 place-items-center rounded-full bg-black/80 text-[10px] font-bold text-[#ffce1a]">{i + 1}</span>
                    <button type="button" aria-label={t("common.delete")} onClick={() => r.removeStep(s.id)} className="absolute right-1 top-1 hidden rounded bg-black/70 p-1 text-white hover:bg-red-600 group-hover:block">
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {failed && <Button onClick={() => void finish()}>{t("sops.rec.retry")}</Button>}
          </div>
        )}

        {phase === "saving" && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="size-8 animate-spin text-primary" />
            <p className="text-sm">{t("sops.rec.saving", { done: progress, count: r?.steps.length ?? 0 })}</p>
          </div>
        )}

        {phase === "done" && savedId && (
          <div className="space-y-4 py-2 text-center">
            <CheckCircle2 className="mx-auto size-10 text-emerald-400" />
            <p className="font-medium">{t("sops.rec.saved", { count: r?.steps.length ?? 0 })}</p>
            <p className="text-sm text-muted-foreground">{t("sops.rec.savedHint")}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => onDone(savedId)}>{t("sops.rec.open")}</Button>
              {videoFile && (
                <Button
                  variant="outline"
                  onClick={() => {
                    saveAs(`${fileName(title || "enregistrement")}.webm`, videoFile);
                    toast.success(t("sops.rec.videoSaved"));
                  }}
                >
                  <Download className="size-4" /> {t("sops.rec.videoDownload", { size: Math.max(1, Math.round(videoFile.size / 1048576)) })}
                </Button>
              )}
            </div>
            {videoFile && (
              <div className="space-y-3 rounded-lg border bg-muted/30 p-3 text-left">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Clapperboard className="size-4 text-primary" /> {t("sops.rec.montage.title")}
                </p>
                <p className="text-xs text-muted-foreground">{t("sops.rec.montage.text")}</p>
                {montage !== null ? (
                  <div className="space-y-2">
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(montage * 100)}%` }} />
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>{t("sops.rec.montage.working", { pct: Math.round(montage * 100) })}</span>
                      <Button size="sm" variant="ghost" onClick={() => montageAbort.current?.abort()}>
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : edited ? (
                  <div className="space-y-2">
                    <video src={edited.url} controls className="w-full rounded-md bg-black" />
                    <Button
                      size="sm"
                      onClick={() => {
                        saveAs(`${fileName(sopTitle || title || "enregistrement")}.webm`, edited.blob);
                        toast.success(t("sops.rec.videoSaved"));
                      }}
                    >
                      <Download className="size-4" /> {t("sops.rec.montage.download", { size: Math.max(1, Math.round(edited.blob.size / 1048576)) })}
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void edit()}>
                    <Clapperboard className="size-4" /> {t("sops.rec.montage.start")}
                  </Button>
                )}
              </div>
            )}
            {videoFile && <p className="text-xs text-muted-foreground">{t("sops.rec.videoNote")}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
