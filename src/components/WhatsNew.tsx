import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gift } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { WhatsNewEntry } from "@shared/whatsnew";

type State = { entries: WhatsNewEntry[]; latest: string | null; seen: string | null };

/**
 * "What's new": a button in the top bar (a red dot while the newest revision is unread) that opens the revisions, newest first,
 * with what each one brought. It opens by itself at sign-in while the newest revision is unread, and once it is read (any way of
 * closing it) never again until a newer revision is added to shared/whatsnew.ts.
 */
export function WhatsNewButton() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const lang = i18n.language === "en" ? "en" : "fr";
  const { data } = useQuery({ queryKey: ["me", "whatsnew"], queryFn: () => api.get<State>("/me/whatsnew"), staleTime: 5 * 60_000 });
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const auto = useRef(false);
  const unread = Boolean(data?.latest && data.latest !== data.seen);

  // at sign-in (the first time the state is known): open on the newest revision when it has not been read
  useEffect(() => {
    if (!data || auto.current) return;
    auto.current = true;
    if (data.latest && data.latest !== data.seen) {
      setPicked(data.latest);
      setOpen(true);
    }
  }, [data]);

  const markSeen = useMutation({
    mutationFn: (id: string) => api.put("/me/whatsnew/seen", { id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["me", "whatsnew"] }),
  });
  const close = () => {
    setOpen(false);
    if (data?.latest && data.latest !== data.seen) markSeen.mutate(data.latest);
  };

  if (!data || !data.entries.length) return null;
  const entry = data.entries.find((e) => e.id === (picked ?? data.latest)) ?? data.entries[0];
  const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(lang === "en" ? "en-CA" : "fr-CA", { day: "numeric", month: "short", year: "numeric" });

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="relative gap-1.5"
        onClick={() => {
          setPicked(data.latest);
          setOpen(true);
        }}
        aria-label={t("whatsNew.button")}
        title={t("whatsNew.button")}
      >
        <Gift className="size-4" aria-hidden />
        <span className="hidden md:inline">{t("whatsNew.button")}</span>
        {unread && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-red-500" aria-hidden />}
      </Button>

      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <DialogContent className="max-h-[88vh] w-[min(46rem,calc(100vw-1.5rem))] max-w-none gap-0 overflow-hidden p-0 sm:max-w-none">
          <div className="flex items-center gap-2 border-b px-5 py-3">
            <Gift className="size-4 text-primary" aria-hidden />
            <DialogTitle className="text-base font-semibold">{t("whatsNew.title")}</DialogTitle>
            <DialogDescription className="sr-only">{t("whatsNew.footer")}</DialogDescription>
          </div>
          <div className="grid max-h-[calc(88vh-7.5rem)] grid-cols-[11rem_minmax(0,1fr)] overflow-hidden sm:grid-cols-[13rem_minmax(0,1fr)]">
            <ul className="overflow-y-auto border-r bg-background/40 p-2" aria-label={t("whatsNew.title")}>
              {data.entries.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(e.id)}
                    aria-current={e.id === entry.id}
                    className={cn("w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-white/5", e.id === entry.id && "bg-primary/10 text-primary")}
                  >
                    <span className="block font-medium">{t("whatsNew.revision", { id: e.id })}</span>
                    <span className="block text-xs text-muted-foreground">
                      {day(e.date)}
                      {e.id === data.latest && unread ? ` · ${t("whatsNew.isNew")}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="space-y-4 overflow-y-auto px-5 py-4 text-sm">
              {entry.sections.map((s) => (
                <section key={s.fr}>
                  <h3 className="mb-1.5 font-semibold">{s[lang]}</h3>
                  <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                    {s.items.map((it) => (
                      <li key={it.fr}>{it[lang]}</li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
            <span className="text-xs text-muted-foreground">{t("whatsNew.footer")}</span>
            <Button type="button" size="sm" variant="outline" onClick={close}>
              {t("whatsNew.understood")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
