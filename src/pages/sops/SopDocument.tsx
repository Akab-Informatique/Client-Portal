import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Download, Printer, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { LogoPill } from "@/components/brand/Logo";
import logoPillUrl from "@/assets/akab-logo-pill.png";
import displayFont from "@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2?inline";
import sans400 from "@fontsource/instrument-sans/files/instrument-sans-latin-400-normal.woff2?inline";
import sans600 from "@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff2?inline";
import { longDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StepImage } from "./StepImage";
import { fileName, imageUrl, saveAs, stepName, type Mark, type SopDetail } from "./shared";

/** The procedure as it is read: a white sheet, the steps one under the other with their pictures */
export function SopSheet({ sop, className }: { sop: SopDetail; className?: string }) {
  const { t } = useTranslation();
  return (
    <article className={cn("sop-sheet mx-auto max-w-[860px] overflow-hidden rounded-lg bg-white text-[14px] leading-relaxed text-neutral-900 shadow-2xl", className)}>
      <header className="flex flex-wrap items-center justify-between gap-4 bg-[#0a0a0b] px-8 py-5" style={{ printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }}>
        <LogoPill className="h-12" />
        <div className="text-right text-xs text-[#a8a8a3]">
          {sop.author && <p>{t("sops.doc.by", { name: sop.author })}</p>}
          <p>{longDate(new Date(sop.updatedAt))}</p>
        </div>
      </header>
      <div className="h-1.5" style={{ background: "linear-gradient(90deg,#ffe24a,#ffce1a 55%,#f59410)", printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }} />
      <div className="px-8 pb-8 pt-6">
        <h1 className="font-display text-3xl font-bold leading-tight tracking-tight">{sop.title}</h1>
        {sop.description && <p className="mt-3 whitespace-pre-wrap text-neutral-700">{sop.description}</p>}
        <p className="mt-2 text-xs text-neutral-500">{t("sops.doc.stepCount", { count: sop.steps.length })}</p>
        <ol className="mt-6 space-y-7">
          {sop.steps.map((s, i) => (
              <li key={s.id} className="sop-step break-inside-avoid">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-neutral-900 text-sm font-bold text-[#ffce1a]" style={{ printColorAdjust: "exact" }}>
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-semibold leading-snug">{stepName(s, i, t("sops.step"))}</h2>
                    {s.description && <p className="mt-1 whitespace-pre-wrap text-neutral-700">{s.description}</p>}
                  </div>
                </div>
                {s.hasImage && <StepImage src={imageUrl(sop.id, s)} marks={s.marks} className="mt-3 border-neutral-300 bg-white" alt={stepName(s, i, t("sops.step"))} />}
              </li>
          ))}
        </ol>
      </div>
      <footer className="flex items-center justify-between gap-3 bg-[#0a0a0b] px-8 py-3 text-[11px] text-[#a8a8a3]" style={{ printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }}>
        <span>{t("sops.doc.exported")}</span>
        <span className="font-semibold text-[#ffce1a]">akab.ca</span>
      </footer>
    </article>
  );
}

/** The sheet over the page, to print or save as PDF (only the sheet is printed: CSS `html.printing-sop`) */
export function SopPrint({ sop, onClose }: { sop: SopDetail; onClose: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const before = document.title;
    document.title = sop.title;
    document.documentElement.classList.add("printing-sop");
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.title = before;
      document.documentElement.classList.remove("printing-sop");
      window.removeEventListener("keydown", onKey);
    };
  }, [sop.title, onClose]);
  return createPortal(
    <div className="sop-overlay fixed inset-0 z-[100] overflow-y-auto bg-black/80 p-4 sm:p-8" role="dialog" aria-modal="true" aria-label={sop.title}>
      <div className="no-print mx-auto mb-4 flex max-w-[860px] flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-sm text-white/70">{t("sops.doc.hint")}</p>
        <div className="flex gap-2">
          <Button onClick={() => window.print()}>
            <Printer className="size-4" /> {t("sops.doc.print")}
          </Button>
          <Button variant="outline" onClick={onClose}>
            <X className="size-4" /> {t("common.close")}
          </Button>
        </div>
      </div>
      <SopSheet sop={sop} />
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ a file to keep or send */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (n: number) => `${Math.round(n * 10000) / 100}%`;

function marksHtml(marks: Mark[]) {
  let pins = 0;
  return marks
    .map((m) =>
      m.kind === "box"
        ? `<span class="box" style="left:${pct(m.x)};top:${pct(m.y)};width:${pct(m.w ?? 0)};height:${pct(m.h ?? 0)}"></span>`
        : `<span class="pin" style="left:${pct(m.x)};top:${pct(m.y)}">${++pins}</span>`,
    )
    .join("");
}

/** One self-contained HTML file: the pictures are inside it, so it can be emailed or opened anywhere */
export type Brand = { logo: string; display: string; sans400: string; sans600: string };

export function buildHtml(sop: SopDetail, pictures: Record<string, string>, brand: Brand, w: { step: string; by: (name: string) => string; stepCount: string; date: string; exported: string }) {
  const steps = sop.steps
    .map((s, i) => {
      const name = s.title.trim() || `${w.step} ${i + 1}`;
      const img = pictures[s.id] ? `<div class="shot"><img src="${pictures[s.id]}" alt="${esc(name)}">${marksHtml(s.marks)}</div>` : "";
      return `<li><div class="head"><span class="n">${i + 1}</span><div><h2>${esc(name)}</h2>${s.description ? `<p>${esc(s.description)}</p>` : ""}</div></div>${img}</li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(sop.title)}</title>
<style>
@font-face{font-family:"Bricolage Grotesque";font-weight:200 800;src:url(${brand.display}) format("woff2")}
@font-face{font-family:"Instrument Sans";font-weight:400;src:url(${brand.sans400}) format("woff2")}
@font-face{font-family:"Instrument Sans";font-weight:600;src:url(${brand.sans600}) format("woff2")}
*{box-sizing:border-box}body{margin:0;background:#f4f4f1;color:#0a0a0b;font:15px/1.55 "Instrument Sans","Segoe UI",system-ui,sans-serif}
main{max-width:900px;margin:0 auto;background:#fff;box-shadow:0 10px 40px rgba(0,0,0,.15)}
.top{background:#0a0a0b;padding:18px 40px;display:flex;align-items:center;justify-content:space-between;gap:16px;print-color-adjust:exact;-webkit-print-color-adjust:exact}.top img{height:46px;display:block}.top span{color:#a8a8a3;font-size:12px;text-align:right}
.rule{height:6px;background:linear-gradient(90deg,#ffe24a,#ffce1a 55%,#f59410);print-color-adjust:exact;-webkit-print-color-adjust:exact}
.body{padding:30px 40px 34px}
h1{font-family:"Bricolage Grotesque","Segoe UI",system-ui,sans-serif;font-size:32px;line-height:1.12;letter-spacing:-.01em;margin:0 0 6px}.meta{color:#666;font-size:12px;margin:0 0 4px}.desc{white-space:pre-wrap;color:#333}
ol{list-style:none;padding:0;margin:28px 0 0}li{margin:0 0 30px;break-inside:avoid}
.head{display:flex;gap:12px;align-items:flex-start}.n{flex:none;width:34px;height:34px;border-radius:50%;background:#0a0a0b;color:#ffce1a;font-weight:600;display:grid;place-items:center;print-color-adjust:exact;-webkit-print-color-adjust:exact}
h2{font-family:"Bricolage Grotesque","Segoe UI",system-ui,sans-serif;font-size:19px;margin:3px 0 2px}.head p{margin:2px 0 0;white-space:pre-wrap;color:#333}
.shot{position:relative;margin-top:12px;border:1px solid #d4d4d4;border-radius:8px;overflow:hidden}.shot img{display:block;width:100%}
.box{position:absolute;border:3px solid #ffce1a;border-radius:6px;background:rgba(255,206,26,.12)}
.pin{position:absolute;width:36px;height:36px;margin:-18px 0 0 -18px;border:3px solid #ffce1a;border-radius:50%;background:rgba(255,206,26,.35);display:grid;place-items:center;font-weight:600;font-size:13px}
footer{background:#0a0a0b;color:#a8a8a3;font-size:11px;padding:12px 40px;display:flex;justify-content:space-between;print-color-adjust:exact;-webkit-print-color-adjust:exact}footer b{color:#ffce1a}
@media print{body{background:#fff}main{box-shadow:none;max-width:none}@page{size:letter;margin:10mm}}
</style></head><body><main>
<div class="top"><img src="${brand.logo}" alt="AKAB Informatique"><span>${[sop.author ? esc(w.by(sop.author)) : "", esc(w.date)].filter(Boolean).join("<br>")}</span></div><div class="rule"></div>
<div class="body">
<h1>${esc(sop.title)}</h1>
<p class="meta">${esc(w.stepCount)}</p>
${sop.description ? `<p class="desc">${esc(sop.description)}</p>` : ""}
<ol>
${steps}
</ol></div>
<footer><span>${esc(w.exported)}</span><b>akab.ca</b></footer>
</main></body></html>`;
}

/** Read every picture of the procedure and save the whole thing as one HTML file */
export async function downloadHtml(sop: SopDetail, t: (k: string, o?: Record<string, unknown>) => string) {
  const pictures: Record<string, string> = {};
  for (const s of sop.steps) {
    if (!s.hasImage) continue;
    const res = await fetch(imageUrl(sop.id, s), { credentials: "same-origin" });
    if (!res.ok) throw new Error("image");
    const blob = await res.blob();
    pictures[s.id] = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  const asData = async (url: string) => {
    const blob = await (await fetch(url)).blob();
    return new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  };
  const brand: Brand = { logo: await asData(logoPillUrl), display: displayFont, sans400, sans600 };
  const html = buildHtml(sop, pictures, brand, {
    step: t("sops.step"),
    by: (name) => t("sops.doc.by", { name }),
    stepCount: t("sops.doc.stepCount", { count: sop.steps.length }),
    date: longDate(new Date(sop.updatedAt)),
    exported: t("sops.doc.exported"),
  });
  saveAs(`${fileName(sop.title)}.html`, new Blob([html], { type: "text/html;charset=utf-8" }));
}

/** The two buttons that go with a procedure that is read: print or PDF, and a file to send */
export function SopActions({ sop, onPrint }: { sop: SopDetail; onPrint: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <Button variant="outline" onClick={onPrint} disabled={!sop.steps.length}>
        <Printer className="size-4" /> {t("sops.doc.print")}
      </Button>
      <Button
        variant="outline"
        disabled={!sop.steps.length}
        onClick={() =>
          void downloadHtml(sop, t as never).then(
            () => toast.success(t("sops.doc.downloaded")),
            () => toast.error(t("common.error")),
          )
        }
      >
        <Download className="size-4" /> {t("sops.doc.download")}
      </Button>
    </>
  );
}
