import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, TriangleAlert } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SURVEY, surveyKey, surveySummary, type SurveyField, type SurveySection, type SurveyTable } from "@shared/quoteSurvey";

type Lang = "fr" | "en";
type Props = { answers: Record<string, string>; onChange: (key: string, value: string) => void; disabled?: boolean };

/** The IT checklist of a site visit: the figures at the top, then one card per section. */
export function SurveyPanel({ answers, onChange, disabled }: Props) {
  const { t, i18n } = useTranslation();
  const lang: Lang = i18n.language === "en" ? "en" : "fr";
  const [open, setOpen] = useState<Record<string, boolean>>({ general: true });
  const sum = surveySummary(answers);
  const pct = sum.total ? Math.round((sum.answered / sum.total) * 100) : 0;
  const titleOf = (key: string) => SURVEY.find((s) => s.key === key)?.title[lang] ?? key;

  return (
    <div className="space-y-4">
      <section className="glass space-y-4 rounded-2xl border p-5">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Figure label={t("quotes.survey.users")} value={sum.users} />
          <Figure label={t("quotes.survey.workstations")} value={sum.workstations} />
          <Figure label={t("quotes.survey.mobiles")} value={sum.mobiles} />
          <Figure label={t("quotes.survey.servers")} value={sum.servers} />
          <Figure label={t("quotes.survey.licences")} value={sum.licences} />
        </dl>
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between text-xs text-muted-foreground">
            <span>{t("quotes.survey.progress", { done: sum.answered, total: sum.total })}</span>
            <span className="tabular-nums">{pct} %</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-[color:var(--gold)] transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="border-t pt-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <TriangleAlert className={cn("size-4", sum.risks.length ? "text-amber-400" : "text-muted-foreground")} /> {t("quotes.survey.risks", { count: sum.risks.length })}
          </h3>
          {sum.risks.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">{t("quotes.survey.risksNone")}</p>
          ) : (
            <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">
              {sum.risks.map((r) => (
                <li key={`${r.section}.${r.field.key}`} className="flex gap-2">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden />
                  <span>
                    {r.field.label[lang]} <span className="text-muted-foreground">({titleOf(r.section)})</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {SURVEY.map((s, i) => (
        <SectionCard key={s.key} section={s} index={i + 1} lang={lang} open={Boolean(open[s.key])} onToggle={() => setOpen((o) => ({ ...o, [s.key]: !o[s.key] }))} answers={answers} onChange={onChange} disabled={disabled} />
      ))}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-bold tabular-nums">{value}</dd>
    </div>
  );
}

function SectionCard({ section, index, lang, open, onToggle, answers, onChange, disabled }: Props & { section: SurveySection; index: number; lang: Lang; open: boolean; onToggle: () => void }) {
  const done = section.blocks.flatMap((b) => ("fields" in b ? b.fields.map((x) => surveyKey(section.key, x.key)) : b.table.rows.flatMap((r) => b.table.cols.map((c) => surveyKey(section.key, b.table.key, r.key, c.key))))).filter((k) => answers[k] && answers[k] !== "0").length;
  return (
    <section className="glass overflow-hidden rounded-2xl border">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-accent/40">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg border text-xs font-semibold tabular-nums">{index}</span>
        <span className="min-w-0 flex-1 text-lg font-semibold">{section.title[lang]}</span>
        {done > 0 && <span className="text-xs text-muted-foreground tabular-nums">{done}</span>}
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <fieldset disabled={disabled} className="space-y-5 border-t px-5 py-5">
          {section.blocks.map((b, i) =>
            "table" in b ? (
              <TableBlock key={i} section={section.key} table={b.table} lang={lang} answers={answers} onChange={onChange} />
            ) : (
              <div key={i} className="grid gap-x-4 gap-y-4 md:grid-cols-2">
                {b.fields.map((x) => (
                  <FieldInput key={x.key} field={x} lang={lang} value={answers[surveyKey(section.key, x.key)] ?? ""} onChange={(v) => onChange(surveyKey(section.key, x.key), v)} />
                ))}
              </div>
            ),
          )}
        </fieldset>
      )}
    </section>
  );
}

function FieldInput({ field, lang, value, onChange }: { field: SurveyField; lang: Lang; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const id = `sv-${field.key}`;
  const label = field.label[lang];
  const risky = field.risk === "yes" ? value === "1" || value === "yes" : field.risk === "no" ? value === "no" : false;
  if (field.type === "check") {
    return (
      <label htmlFor={id} className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm md:col-span-2", risky && "border-amber-500/40 bg-amber-500/5")}>
        <Checkbox id={id} checked={value === "1"} onCheckedChange={(c) => onChange(c === true ? "1" : "")} className="mt-0.5" />
        <span>{label}</span>
      </label>
    );
  }
  if (field.type === "ynu") {
    return (
      <div className={cn("flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 md:col-span-2", risky && "border-amber-500/40 bg-amber-500/5")}>
        <span id={id} className="min-w-0 flex-1 basis-60 text-sm">
          {label}
        </span>
        <div role="radiogroup" aria-labelledby={id} className="flex overflow-hidden rounded-lg border">
          {(["yes", "no"] as const).map((o) => (
            <button key={o} type="button" role="radio" aria-checked={value === o} onClick={() => onChange(value === o ? "" : o)} className={cn("px-3.5 py-1.5 text-sm transition-colors", value === o ? (o === "yes" ? "bg-emerald-500/20 text-emerald-200" : "bg-red-500/20 text-red-200") : "text-muted-foreground hover:bg-accent")}>
              {t(`quotes.survey.${o}`)}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className={cn("space-y-1.5", field.type === "long" && "md:col-span-2")}>
      <Label htmlFor={id}>{label}</Label>
      {field.type === "long" ? (
        <Textarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} className="bg-background/40" />
      ) : (
        <Input id={id} type={field.type === "date" ? "date" : "text"} inputMode={field.type === "number" ? "numeric" : undefined} value={value} onChange={(e) => onChange(e.target.value)} className={cn("bg-background/40", field.type === "number" && "tabular-nums")} />
      )}
    </div>
  );
}

function TableBlock({ section, table, lang, answers, onChange }: { section: string; table: SurveyTable; lang: Lang; answers: Record<string, string>; onChange: (key: string, value: string) => void }) {
  const grid = { "--cols": `minmax(9rem,1.3fr) 4.5rem repeat(${table.cols.length - 1}, minmax(0,1fr))` } as CSSProperties;
  return (
    <div className="space-y-2">
      <div className="hidden gap-2 px-1 text-xs text-muted-foreground md:grid md:grid-cols-[var(--cols)]" style={grid} aria-hidden>
        <span />
        {table.cols.map((c) => (
          <span key={c.key}>{c.label[lang]}</span>
        ))}
      </div>
      {table.rows.map((r) => (
        <div key={r.key} className="grid gap-2 rounded-xl border p-3 md:grid-cols-[var(--cols)] md:items-center md:border-0 md:p-1" style={grid}>
          <span className="text-sm font-medium">{r.label[lang]}</span>
          {table.cols.map((c) => (
            <Input
              key={c.key}
              aria-label={`${r.label[lang]}: ${c.label[lang]}`}
              placeholder={c.label[lang]}
              inputMode={c.type === "number" ? "numeric" : undefined}
              value={answers[surveyKey(section, table.key, r.key, c.key)] ?? ""}
              onChange={(e) => onChange(surveyKey(section, table.key, r.key, c.key), e.target.value)}
              className={cn("h-9 bg-background/40", c.type === "number" && "text-right tabular-nums")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
