import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Inbox, Loader2, Paperclip, Search, Send, Ticket, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { TicketSummary } from "@/pages/tickets/shared";
import {
  base,
  bytes,
  fileToBase64,
  KEY,
  outlookErrorText,
  parseAddresses,
  statusKey,
  who,
  type ComposeMode,
  type MailAccount,
  type MailMessage,
  type OutlookStatus,
} from "./shared";

const GOLD = "bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105";

/** Link one of my AKAB mailboxes (or any, with the right). */
export function LinkMailboxDialog({ open, onOpenChange, status, onLinked }: { open: boolean; onOpenChange: (o: boolean) => void; status: OutlookStatus; onLinked: (a: MailAccount) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const linkedSet = new Set(status.accounts.map((a) => a.address.toLowerCase()));
  const own = status.ownAddresses.filter((a) => !linkedSet.has(a));
  const [address, setAddress] = useState("");
  useEffect(() => {
    if (open) setAddress(own[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const link = useMutation({
    mutationFn: () => api.post<MailAccount>("/outlook/accounts", { address: address.trim() }),
    onSuccess: (a) => {
      toast.success(t("outlook.linked"));
      void qc.invalidateQueries({ queryKey: statusKey });
      onOpenChange(false);
      onLinked(a);
    },
    onError: (e) => toast.error(outlookErrorText(t, e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Inbox className="size-5 text-primary" /> {t("outlook.linkTitle")}
          </DialogTitle>
          <DialogDescription>{status.canLinkAny ? t("outlook.linkTextAny") : status.signedIn ? t("outlook.linkTextShared") : t("outlook.linkText")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            link.mutate();
          }}
        >
          {/* signed in: their address or a mailbox shared with them (Microsoft checks the access) */}
          {status.canLinkAny || status.signedIn ? (
            <div className="space-y-2">
              <Label htmlFor="ol-address">{t("outlook.address")}</Label>
              <Input id="ol-address" type="email" required autoFocus value={address} onChange={(e) => setAddress(e.target.value)} placeholder="support@akab.ca" />
              {own.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {own.map((a) => (
                    <button key={a} type="button" onClick={() => setAddress(a)} className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:border-[color:var(--gold)]/50 hover:text-foreground">
                      {a}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Label>{t("outlook.address")}</Label>
              {own.length ? (
                <Select value={address} onValueChange={setAddress}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {own.map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{t("outlook.errors.already_linked")}</p>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={link.isPending || !address.trim()} className={GOLD}>
              {link.isPending && <Loader2 className="size-4 animate-spin" />} {t("outlook.link")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Draft = { accountId: string; to: string; cc: string; bcc: string; subject: string; text: string; files: File[] };

/** New email, reply, reply all or forward — with files. */
export function ComposeDialog({
  open,
  onOpenChange,
  mode,
  accounts,
  accountId,
  message,
  maxBytes,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: ComposeMode;
  accounts: MailAccount[];
  accountId: string;
  message: MailMessage | null;
  maxBytes: number;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [d, setD] = useState<Draft>({ accountId, to: "", cc: "", bcc: "", subject: "", text: "", files: [] });
  useEffect(() => {
    if (open) setD({ accountId, to: "", cc: "", bcc: "", subject: "", text: "", files: [] });
  }, [open, accountId, mode, message?.id]);
  const total = useMemo(() => d.files.reduce((n, f) => n + f.size, 0), [d.files]);
  const tooBig = total > maxBytes;

  const send = useMutation({
    mutationFn: async () => {
      const to = parseAddresses(d.to);
      const cc = parseAddresses(d.cc);
      const bcc = parseAddresses(d.bcc);
      const bad = to.bad ?? cc.bad ?? bcc.bad;
      if (bad) throw new Error(t("outlook.errors.invalid_address", { address: bad }));
      if ((mode === "new" || mode === "forward") && !to.ok.length) throw new Error(t("outlook.errors.no_recipient"));
      const attachments = await Promise.all(d.files.map(async (f) => ({ name: f.name, contentType: f.type || "application/octet-stream", data: await fileToBase64(f) })));
      if (mode === "new") {
        return api.post(`${base(d.accountId)}/send`, { to: to.ok, cc: cc.ok, bcc: bcc.ok, subject: d.subject, text: d.text, attachments });
      }
      return api.post(`${base(d.accountId)}/messages/${encodeURIComponent(message!.id)}/respond`, { mode, text: d.text, to: to.ok, cc: cc.ok, attachments });
    },
    onSuccess: () => {
      toast.success(t("outlook.sentOk"));
      void qc.invalidateQueries({ queryKey: [...KEY, "folders", d.accountId] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof Error && !("code" in e) ? e.message : outlookErrorText(t, e)),
  });

  const title = mode === "new" ? t("outlook.newMail") : mode === "forward" ? t("outlook.forward") : mode === "replyAll" ? t("outlook.replyAll") : t("outlook.reply");
  const showTo = mode === "new" || mode === "forward";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="size-5 text-primary" /> {title}
          </DialogTitle>
          <DialogDescription>
            {message && mode !== "new" ? (
              <>
                {mode === "forward" ? `${t("outlook.subject")} : ${message.subject || t("outlook.noSubject")}` : t("outlook.replyTo", { name: who(message.from) })}
                {" · "}
                {t("outlook.quotedNote")}
              </>
            ) : (
              t("outlook.recipientsHint")
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          {mode === "new" && accounts.length > 1 && (
            <Row label={t("outlook.fromAccount")}>
              <Select value={d.accountId} onValueChange={(v) => setD({ ...d, accountId: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.address}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          )}
          {showTo && (
            <Row label={t("outlook.to")}>
              <Input autoFocus value={d.to} onChange={(e) => setD({ ...d, to: e.target.value })} placeholder="nom@exemple.ca" />
            </Row>
          )}
          <Row label={t("outlook.cc")}>
            <Input value={d.cc} onChange={(e) => setD({ ...d, cc: e.target.value })} />
          </Row>
          {mode === "new" && (
            <>
              <Row label={t("outlook.bcc")}>
                <Input value={d.bcc} onChange={(e) => setD({ ...d, bcc: e.target.value })} />
              </Row>
              <Row label={t("outlook.subject")}>
                <Input maxLength={250} value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} />
              </Row>
            </>
          )}
          <Textarea autoFocus={!showTo} rows={10} value={d.text} onChange={(e) => setD({ ...d, text: e.target.value })} aria-label={t("outlook.body")} className="min-h-48" />

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                <Paperclip className="size-4" /> {t("outlook.attach")}
              </Button>
              <span className={cn("text-xs", tooBig ? "text-destructive" : "text-muted-foreground")}>
                {d.files.length ? `${bytes(total)} / ` : ""}
                {t("outlook.attachLimit", { size: bytes(maxBytes) })}
              </span>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  setD((x) => ({ ...x, files: [...x.files, ...picked].slice(0, 10) }));
                  e.target.value = "";
                }}
              />
            </div>
            {d.files.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {d.files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-1.5 rounded-lg border bg-card/60 px-2 py-1 text-xs">
                    <Paperclip className="size-3 text-muted-foreground" />
                    <span className="max-w-48 truncate">{f.name}</span>
                    <span className="text-muted-foreground">{bytes(f.size)}</span>
                    <button type="button" aria-label={t("common.delete")} onClick={() => setD((x) => ({ ...x, files: x.files.filter((_, j) => j !== i) }))}>
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={send.isPending || tooBig} className={GOLD}>
              {send.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("outlook.send")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid items-center gap-1.5 sm:grid-cols-[90px_1fr] sm:gap-3">
      <Label className="text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

/** Pick a ticket; the email is copied into it as an internal note. */
export function AddToTicketDialog({ open, onOpenChange, accountId, message }: { open: boolean; onOpenChange: (o: boolean) => void; accountId: string; message: MailMessage | null }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => {
    if (open) {
      setQ("");
      setDebounced("");
    }
  }, [open]);
  const results = useQuery({
    queryKey: ["tickets", "search", debounced],
    queryFn: () => api.get<{ items: TicketSummary[] }>(`/tickets/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length >= 2,
  });
  const add = useMutation({
    mutationFn: (tk: TicketSummary) => api.post(`${base(accountId)}/messages/${encodeURIComponent(message!.id)}/to-ticket`, { ticketId: tk.id }).then(() => tk),
    onSuccess: (tk) => {
      toast.success(t("outlook.added", { number: tk.number }));
      onOpenChange(false);
    },
    onError: (e) => toast.error(outlookErrorText(t, e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ticket className="size-5 text-primary" /> {t("outlook.toTicketTitle")}
          </DialogTitle>
          <DialogDescription>{t("outlook.toTicketText")}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("outlook.searchTicket")} />
        </div>
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {results.isFetching && (
            <li className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </li>
          )}
          {(results.data?.items ?? []).map((tk) => (
            <li key={tk.id}>
              <button
                type="button"
                disabled={add.isPending}
                onClick={() => add.mutate(tk)}
                className="flex w-full items-start gap-3 rounded-lg border border-transparent px-3 py-2 text-left hover:border-[color:var(--gold)]/40 hover:bg-accent/50"
              >
                <span className="mt-0.5 font-mono text-xs text-primary">{tk.number}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{tk.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{tk.company.name}</span>
                </span>
              </button>
            </li>
          ))}
          {debounced.length >= 2 && !results.isFetching && !(results.data?.items ?? []).length && (
            <li className="py-6 text-center text-sm text-muted-foreground">{t("tickets.emptyFiltered")}</li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
