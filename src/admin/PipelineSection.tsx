import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, Loader2, MessageSquareText, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api";
import { SectionHeader } from "./sections";

type Settings = { auto: boolean; time: string; sms: boolean; workStart: string; workEnd: string; lunchStart: string; lunchEnd: string };
type Target = { id: string; name: string; phone: string | null };

/**
 * Admin › PSA › Pipeline: the morning plan (its time, the text to each technician, the work and lunch hours),
 * running it now, and a test text to one person to check their number and the text line.
 */
export function PipelineSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["pipeline", "settings"], queryFn: () => api.get<Settings>("/pipeline/settings") });
  const targets = useQuery({ queryKey: ["pipeline", "test-targets"], queryFn: () => api.get<Target[]>("/pipeline/test-targets") });
  const [f, setF] = useState<Settings | null>(null);
  const [who, setWho] = useState("");
  useEffect(() => {
    if (data) setF(data);
  }, [data]);
  useEffect(() => {
    if (!who && targets.data?.length) setWho(targets.data.find((x) => x.phone)?.id ?? targets.data[0].id);
  }, [targets.data, who]);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF((s) => (s ? { ...s, [k]: v } : s));
  const dirty = Boolean(f && data && (Object.keys(f) as (keyof Settings)[]).some((k) => f[k] !== data[k]));

  const save = useMutation({
    mutationFn: (s: Settings) => api.put<Settings>("/pipeline/settings", s),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pipeline"] });
      toast.success(t("common.saved"));
    },
    onError: () => toast.error(t("pipeline.settings.invalid")),
  });
  const run = useMutation({
    mutationFn: (sms: boolean) => api.post<{ planned: number; texted: number; failed: number }>("/pipeline/morning/run", { sms }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["pipeline"] });
      toast.success(t("pipeline.settings.ran", { planned: r.planned, texted: r.texted, failed: r.failed }));
    },
    onError: () => toast.error(t("common.error")),
  });
  const test = useMutation({
    mutationFn: (mode: "plan" | "short") => api.post<{ to: string }>("/pipeline/morning/test-sms", { userId: who, mode }),
    onSuccess: (r) => toast.success(t("pipeline.settings.testSent", { to: r.to })),
    onError: (e) => toast.error(e instanceof ApiError && ["no_phone", "sms_not_ready", "sms_failed", "not_found"].includes(e.code) ? t(`pipeline.settings.testErrors.${e.code}`) : t("common.error")),
  });
  const person = targets.data?.find((x) => x.id === who);

  if (!f)
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  return (
    <div className="max-w-3xl space-y-6">
      <SectionHeader title={t("pipeline.settings.title")} subtitle={t("pipeline.settings.text")} />

      <section className="glass space-y-4 rounded-2xl border p-5">
        <label className="flex items-center justify-between gap-3">
          <span className="space-y-0.5">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <Sparkles className="size-4 text-primary" /> {t("pipeline.settings.auto")}
            </span>
            <span className="block text-xs text-muted-foreground">{t("pipeline.settings.autoHint")}</span>
          </span>
          <Switch checked={f.auto} onCheckedChange={(v) => set("auto", v)} />
        </label>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <CalendarClock className="size-3" /> {t("pipeline.settings.time")}
            </span>
            <Input type="time" value={f.time} onChange={(e) => set("time", e.target.value)} className="text-foreground" />
          </label>
          <label className="col-span-2 flex items-end gap-2 pb-2 text-sm sm:col-span-2">
            <Switch checked={f.sms} onCheckedChange={(v) => set("sms", v)} />
            <span className="flex items-center gap-1">
              <MessageSquareText className="size-4" /> {t("pipeline.settings.sms")}
            </span>
          </label>
        </div>
        <p className="-mt-2 text-[11px] text-muted-foreground">{t("pipeline.settings.smsHint")}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(
            [
              ["workStart", t("pipeline.settings.workStart")],
              ["lunchStart", t("pipeline.settings.lunchStart")],
              ["lunchEnd", t("pipeline.settings.lunchEnd")],
              ["workEnd", t("pipeline.settings.workEnd")],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="space-y-1 text-xs text-muted-foreground">
              {label}
              <Input type="time" value={f[k]} onChange={(e) => set(k, e.target.value)} className="text-foreground" />
            </label>
          ))}
        </div>
        <div className="flex justify-end">
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate(f)} className="bg-grad-gold font-semibold text-[#1a1204]">
            {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
          </Button>
        </div>
      </section>

      {/* a test text to one person */}
      <section className="glass space-y-3 rounded-2xl border p-5">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Send className="size-4 text-primary" /> {t("pipeline.settings.testTitle")}
        </h3>
        <p className="text-xs text-muted-foreground">{t("pipeline.settings.testText")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <select value={who} onChange={(e) => setWho(e.target.value)} className="h-9 min-w-56 rounded-md border bg-transparent px-2 text-sm" aria-label={t("pipeline.settings.testWho")}>
            {(targets.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} {p.phone ? `· ${p.phone}` : `· ${t("pipeline.settings.noNumber")}`}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" disabled={!who || !person?.phone || test.isPending} onClick={() => test.mutate("short")}>
            {test.isPending && test.variables === "short" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} {t("pipeline.settings.testShort")}
          </Button>
          <Button variant="outline" size="sm" disabled={!who || !person?.phone || test.isPending} onClick={() => test.mutate("plan")}>
            {test.isPending && test.variables === "plan" ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquareText className="size-3.5" />} {t("pipeline.settings.testPlan")}
          </Button>
        </div>
        {person && !person.phone && <p className="text-xs text-orange-300">{t("pipeline.settings.noNumberHint")}</p>}
      </section>

      <section className="glass space-y-3 rounded-2xl border p-5">
        <h3 className="text-sm font-semibold">{t("pipeline.settings.runTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("pipeline.settings.runText")}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={run.isPending} onClick={() => run.mutate(false)}>
            {run.isPending && run.variables === false && <Loader2 className="size-3.5 animate-spin" />} {t("pipeline.settings.runNow")}
          </Button>
          <Button variant="outline" size="sm" disabled={run.isPending} onClick={() => run.mutate(true)}>
            <MessageSquareText className="size-3.5" /> {t("pipeline.settings.runNowSms")}
          </Button>
        </div>
      </section>
    </div>
  );
}
