import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FileText, Loader2, Paperclip, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Pane } from "./ui";
import { DELEGATE_API, MAX_FILE_BYTES, fileToBase64, sizeOf, useDelegateError, type DelegateFile } from "./delegateShared";

/** Sends files to the ticket one by one (base64, 5 MB each). Returns the busy flag and the upload action. */
export function useFileUpload(ticketId: number, onDone: () => void) {
  const { t } = useTranslation();
  const errorText = useDelegateError();
  const [busy, setBusy] = useState(false);

  const upload = async (list: File[]) => {
    setBusy(true);
    try {
      for (const file of list) {
        if (file.size > MAX_FILE_BYTES) {
          toast.error(t("selfManaged.delegate.errors.file_too_big"));
          continue;
        }
        const data = await fileToBase64(file);
        await api.post(`${DELEGATE_API}/tickets/${ticketId}/attachments`, {
          name: file.name.slice(0, 200),
          contentType: file.type || "application/octet-stream",
          data,
        });
        toast.success(t("selfManaged.delegate.ticket.attachments.fileAdded"));
      }
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
      onDone();
    }
  };

  return { upload, busy };
}

/** Files of the ticket: a list with download links, and the add button / drop zone */
export function AttachmentsPanel({ ticketId, files, onChanged }: { ticketId: number; files: DelegateFile[]; onChanged: () => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { upload, busy } = useFileUpload(ticketId, onChanged);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (list.length) void upload(list);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const list = Array.from(e.dataTransfer.files);
    if (list.length && !busy) void upload(list);
  };

  return (
    <Pane className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{t("selfManaged.delegate.ticket.attachments.title")}</span>
        <Button type="button" size="sm" variant="outline" className="h-8 gap-2" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <UploadCloud className="size-3.5" />}
          {busy ? t("selfManaged.delegate.ticket.attachments.uploading") : t("selfManaged.delegate.ticket.attachments.upload")}
        </Button>
      </div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn("rounded-xl border border-dashed p-3 text-center text-xs text-muted-foreground transition-colors", dragging && "border-[color:var(--gold)] text-primary")}
      >
        {t("selfManaged.delegate.ticket.attachments.dropHint")}
      </div>
      <input ref={input} type="file" multiple hidden onChange={onPick} aria-label={t("selfManaged.delegate.ticket.attachments.upload")} />
      {files.length ? (
        <ul className="space-y-2">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 rounded-xl border border-[color:var(--glass-border)] p-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] text-primary">
                <FileText className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{f.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{[sizeOf(f.size), dateTime(f.at)].join(" · ")}</span>
              </span>
              <a
                href={`/api${DELEGATE_API}/tickets/${ticketId}/files/${f.id}`}
                className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-[color:var(--gold)]/10"
              >
                {t("selfManaged.delegate.ticket.attachments.download")}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-center text-xs text-muted-foreground">{t("selfManaged.delegate.ticket.attachments.empty")}</p>
      )}
    </Pane>
  );
}

/** The attach button of the composer: files go to the ticket's attachments */
export function AttachButton({ ticketId, onDone }: { ticketId: number; onDone: () => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const { upload, busy } = useFileUpload(ticketId, onDone);
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (list.length) void upload(list);
  };
  return (
    <>
      <Button type="button" variant="outline" size="sm" className="h-9 gap-2" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Paperclip className="size-3.5" aria-hidden />}
        {t("selfManaged.delegate.ticket.compose.attach")}
      </Button>
      <input ref={input} type="file" multiple hidden onChange={onPick} aria-label={t("selfManaged.delegate.ticket.compose.attach")} />
    </>
  );
}
