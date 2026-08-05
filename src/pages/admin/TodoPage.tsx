import { CheckSquare, Construction } from "lucide-react";
import { BlurFade } from "@/components/ui/blur-fade";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";

/**
 * To-do workspace landing page.
 * Opening this route swaps the entire admin sidebar into To-do mode.
 * Features will be built here together step by step.
 */
export function TodoPage() {
  const { t } = useLocale();

  return (
    <div className="space-y-6">
      <BlurFade delay={0.04}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className="border-primary/40 bg-primary/10 text-primary"
              >
                {t("todo.badge")}
              </Badge>
            </div>
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
              {t("todo.title")}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {t("todo.subtitle")}
            </p>
          </div>
        </div>
      </BlurFade>

      <BlurFade delay={0.08}>
        <Card className="overflow-hidden">
          <CardHeader className="border-b border-border bg-muted/30">
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckSquare className="size-5 text-primary" />
              {t("todo.workspaceReadyTitle")}
            </CardTitle>
            <CardDescription>{t("todo.workspaceReadyDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 p-6">
            <div className="flex items-start gap-3 rounded-xl border border-dashed border-border bg-card/60 p-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Construction className="size-5" />
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-semibold">{t("todo.buildTitle")}</p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t("todo.buildDesc")}
                </p>
              </div>
            </div>

            <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
              <li className="rounded-lg border border-border px-3 py-2">
                {t("todo.hintBack")}
              </li>
              <li className="rounded-lg border border-border px-3 py-2">
                {t("todo.hintNext")}
              </li>
            </ul>
          </CardContent>
        </Card>
      </BlurFade>
    </div>
  );
}
