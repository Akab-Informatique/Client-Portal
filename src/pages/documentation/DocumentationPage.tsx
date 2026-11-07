import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { BookOpen, Library, ListChecks, Loader2 } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { KnowledgeBase } from "./KnowledgeBase";

const SopsPage = lazy(() => import("@/pages/sops/SopsPage").then((m) => ({ default: m.SopsPage })));

/**
 * Documentation: two sections. "Documentation et procédures" holds the step-by-step procedures (SOP) the team makes by
 * recording a screen; "Base de connaissances" holds the articles the team writes. A procedure open (`?sop=`) always
 * shows the first section.
 */
export function DocumentationPage() {
  const { t } = useTranslation();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const sections = [
    ...(can("sops.view") ? [{ key: "docs", icon: ListChecks }] : []),
    ...(can("kb.view") ? [{ key: "kb", icon: Library }] : []),
  ];
  const asked = params.get("section");
  const section = params.get("sop") ? "docs" : sections.some((s) => s.key === asked) ? asked : (sections[0]?.key ?? "docs");
  // a procedure open takes the whole page (its own back button leads here)
  const reading = section === "docs" && Boolean(params.get("sop"));
  return (
    <div className="relative isolate space-y-4">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      {!reading && (
        <>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <BookOpen className="size-6 text-primary" /> {t("documentation.title")}
            </h1>
            <p className="text-sm text-muted-foreground">{t("documentation.subtitle")}</p>
          </div>
          <div className="flex w-fit items-center gap-0.5 rounded-xl border bg-background/40 p-0.5">
            {sections.map(({ key, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setParams({ section: key })}
                className={cn("flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors", section === key ? "bg-[color:var(--gold)]/15 text-primary" : "text-muted-foreground hover:text-foreground")}
              >
                <Icon className="size-4" /> {t(`documentation.sections.${key}`)}
              </button>
            ))}
          </div>
        </>
      )}
      {section === "kb" ? (
        <KnowledgeBase />
      ) : (
        <Suspense fallback={<Loader2 className="mx-auto mt-12 size-6 animate-spin text-muted-foreground" />}>
          <SopsPage embedded />
        </Suspense>
      )}
    </div>
  );
}
