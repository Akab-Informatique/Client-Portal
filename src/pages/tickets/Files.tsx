import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, File as FileIcon, FileText, Image as ImageIcon, Loader2, Mail, MailCheck, Paperclip, Plus, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fileToBase64 } from "@/pages/outlook/shared";
import { longDateTime, type TicketDetail, type TicketFile } from "./shared";

/**
 * The ticket's Attachments tab: every file of the ticket in one place — what came with the client's emails (pictures
 * included), what went out with our replies, what a technician added or the client added in the portal. Pictures show as
 * thumbnails (a click opens them large); every file downloads.
 */
const MAX_BYTES = 5 * 1024 * 1024;
const FILTERS = ["all", "email_in", "email_out", "other"] as const;
type Filter = (typeof FILTERS)[number];

const isPicture = (f: TicketFile) => /^image\/(png|jpe?g|gif|webp)$/i.test(f.contentType ?? "");
const size = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} Mo` : n >= 1024 ? `${Math.round(n / 1024)} Ko` : `${n} o`);

export function TicketFiles({ tk, editable }: { tk: TicketDetail; editable: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [big, setBig] = useState<TicketFile | null>(null);
  const [over, setOver] = useState(false);
  const files = [...(tk.attachments ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  const group = (f: TicketFile): Filter => (f.source === "email_in" ? "email_in" : f.source === "email_out" ? "email_out" : "other");
  const shown = filter === "all" ? files : files.filter((f) => group(f) === filter);
  const count = (k: Filter) => (k === "all" ? files.length : files.filter((f) => group(f) === k).length);
  const url = (f: TicketFile, inline = false) => `/api/tickets/${tk.id}/files/${f.id}${inline ? "?inline=1" : ""}`;

  const upload = useMutation({
    mutationFn: async (list: File[]) => {
      let n = 0;
      for (const f of list) {
        if (f.size > MAX_BYTES) {
          toast.error(t("tickets.files.tooBig", { name: f.name }));
          continue;
        }
        await api.post(`/tickets/${tk.id}/attachments`, { name: f.name, contentType: f.type || "application/octet-stream", data: await fileToBase64(f) });
        n++;
      }
      return n;
    },
    onSuccess: (n) => {
      if (n) toast.success(t("tickets.files.added", { count: n }));
      void qc.invalidateQueries({ queryKey: ["tickets", "detail", tk.id] });
    },
    onError: () => toast.error(t("common.error")),
  });
  const add = (list: FileList | null) => {
    if (list?.length) upload.mutate([...list]);
  };

  const badge = (f: TicketFile) =>
    f.source === "email_in"
      ? { icon: Mail, text: t("tickets.files.fromEmail"), cls: "border-sky-500/40 bg-sky-500/10 text-sky-300" }
      : f.source === "email_out"
        ? { icon: MailCheck, text: t("tickets.files.sentEmail"), cls: "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary" }
        : f.source === "portal"
          ? { icon: UserRound, text: t("tickets.files.fromPortal"), cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" }
          : { icon: Paperclip, text: t("tickets.files.added"), cls: "text-muted-foreground" };

  return (
    <div
      className={cn("space-y-3 rounded-2xl border p-3 transition-colors", over && "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/[0.04]")}
      onDragOver={(e) => {
        if (editable) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!editable) return;
        e.preventDefault();
        setOver(false);
        add(e.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={filter === k}
            onClick={() => setFilter(k)}
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors", filter === k ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 text-primary" : "border-border/70 text-muted-foreground hover:text-foreground")}
          >
            {t(`tickets.files.filter.${k}`)} <span className="tabular-nums opacity-70">{count(k)}</span>
          </button>
        ))}
        {editable && (
          <>
            <input ref={input} type="file" multiple hidden onChange={(e) => (add(e.target.files), (e.target.value = ""))} />
            <Button type="button" size="sm" variant="outline" className="ml-auto h-8 gap-1.5 text-xs" disabled={upload.isPending} onClick={() => input.current?.click()}>
              {upload.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} {t("tickets.files.add")}
            </Button>
          </>
        )}
      </div>

      {!shown.length ? (
        <p className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">{files.length ? t("tickets.files.noneHere") : t("tickets.files.none")}</p>
      ) : (
        <ul className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((f) => {
            const b = badge(f);
            const pic = isPicture(f);
            return (
              <li key={f.id} className="overflow-hidden rounded-xl border bg-card/60">
                {pic ? (
                  <button type="button" onClick={() => setBig(f)} className="block h-32 w-full bg-black/30" title={t("tickets.files.open")}>
                    <img src={url(f, true)} alt={f.name} loading="lazy" className="size-full object-cover" />
                  </button>
                ) : (
                  <div className="flex h-32 items-center justify-center bg-background/40 text-muted-foreground">
                    {/pdf|text|word|sheet/i.test(f.contentType ?? "") ? <FileText className="size-10" /> : <FileIcon className="size-10" />}
                    <span className="ml-2 font-mono text-xs uppercase">{f.name.split(".").pop()?.slice(0, 5)}</span>
                  </div>
                )}
                <div className="space-y-1 p-2.5">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium" title={f.name}>
                    {pic && <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="truncate">{f.name}</span>
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {size(f.size)} · {longDateTime(f.at)}
                  </p>
                  {f.author && <p className="truncate text-[11px] text-muted-foreground">{f.author}</p>}
                  <div className="flex items-center justify-between gap-2 pt-0.5">
                    <span className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium", b.cls)}>
                      <b.icon className="size-3" /> {b.text}
                    </span>
                    <a href={url(f)} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent/50" download>
                      <Download className="size-3" /> {t("tickets.files.download")}
                    </a>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editable && <p className="text-[11px] text-muted-foreground">{t("tickets.files.hint")}</p>}

      {big && (
        <Dialog open onOpenChange={(o) => !o && setBig(null)}>
          <DialogContent className="sm:max-w-4xl">
            <DialogHeader>
              <DialogTitle className="truncate">{big.name}</DialogTitle>
            </DialogHeader>
            <img src={url(big, true)} alt={big.name} className="max-h-[70vh] w-full rounded-lg object-contain" />
            <div className="flex justify-end">
              <a href={url(big)} download className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent/50">
                <Download className="size-4" /> {t("tickets.files.download")}
              </a>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
