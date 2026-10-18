import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, Inbox, Loader2, Paperclip, Search, Send, Ticket, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { TicketSummary } from "@/pages/tickets/shared";
import { RichEditor, type RichEditorHandle } from "./RichEditor";
import { isAddress, RecipientInput } from "./RecipientInput";
import {
  base,
  bytes,
  fileToBase64,
  KEY,
  outlookErrorText,
  statusKey,
  who,
  type ComposeMode,
  type MailAccount,
  type MailMessage,
  type OutlookStatus,
} from "./shared";

const GOLD = "bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105";

/** Link one of my AKAB mailboxes (or any, with the right). */
export function LinkMailboxDialog({
  open,
  onOpenChange,
  status,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  status: OutlookStatus;
  onLinked: (a: MailAccount) => void;
}) {
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
          <DialogDescription>
            {status.canLinkAny ? t("outlook.linkTextAny") : status.signedIn ? t("outlook.linkTextShared") : t("outlook.linkText")}
          </DialogDescription>
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
              <Input
                id="ol-address"
                type="email"
                required
                autoFocus
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="support@akab.ca"
              />
              {own.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {own.map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setAddress(a)}
                      className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:border-[color:var(--gold)]/50 hover:text-foreground"
                    >
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

type Draft = {
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  files: File[];
  importance: "normal" | "high";
  readReceipt: boolean;
  withSignature: boolean;
};

const SIGNATURE_CLASS = "akab-signature";
/** "RE: " / "TR: " once, not "RE: RE: " */
const prefixed = (prefix: string, subject: string) => (/^\s*(re|tr|fw|fwd)\s*:/i.test(subject) ? subject : `${prefix} ${subject}`.trim());

/** Who a reply / reply all goes to, without our own addresses. */
function replyRecipients(mode: ComposeMode, m: MailMessage | null, mine: string[]) {
  if (!m || mode === "new" || mode === "forward") return { to: [] as string[], cc: [] as string[] };
  const own = new Set(mine.map((x) => x.toLowerCase()));
  const list = (l: { address: string }[]) => [...new Set(l.map((x) => x.address.toLowerCase()))].filter((x) => !own.has(x));
  const first = m.replyTo.length ? m.replyTo : m.from ? [m.from] : [];
  if (mode === "reply") return { to: list(first), cc: [] };
  const to = list([...first, ...m.to]);
  return { to, cc: list(m.cc).filter((x) => !to.includes(x)) };
}

/** New email, reply, reply all or forward: recipients with suggestions, formatting, signature, files, options. */
export function ComposeDialog({
  open,
  onOpenChange,
  mode,
  accounts,
  accountId,
  message,
  maxBytes,
  signature,
  initialTo = [],
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: ComposeMode;
  accounts: MailAccount[];
  accountId: string;
  message: MailMessage | null;
  maxBytes: number;
  signature: string;
  initialTo?: string[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const editor = useRef<RichEditorHandle>(null);
  const blank = (): Draft => {
    const r = replyRecipients(
      mode,
      message,
      accounts.map((a) => a.address),
    );
    const subject = !message || mode === "new" ? "" : prefixed(mode === "forward" ? t("outlook.fwPrefix") : t("outlook.rePrefix"), message.subject ?? "");
    return {
      accountId,
      to: mode === "new" ? initialTo : r.to,
      cc: r.cc,
      bcc: [],
      subject,
      files: [],
      importance: "normal",
      readReceipt: false,
      withSignature: Boolean(signature),
    };
  };
  const [d, setD] = useState<Draft>(blank);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [showQuote, setShowQuote] = useState(false);
  const [dragging, setDragging] = useState(false);
  // a new window each time it opens (the editor is mounted again with its key)
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!open) return;
    const b = blank();
    setD(b);
    setShowCc(b.cc.length > 0);
    setShowBcc(false);
    setShowQuote(false);
    setRound((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId, mode, message?.id]);
  const total = useMemo(() => d.files.reduce((n, f) => n + f.size, 0), [d.files]);
  const tooBig = total > maxBytes;
  const initialHtml = useMemo(() => `<p><br></p>${signature ? `<p><br></p><div class="${SIGNATURE_CLASS}">${signature}</div>` : ""}`, [signature, round]);

  /** The signature block in the editor, on or off */
  const toggleSignature = (on: boolean) => {
    const el = editor.current?.element();
    if (!el) return;
    el.querySelectorAll(`.${SIGNATURE_CLASS}`).forEach((n) => n.remove());
    if (on && signature) {
      const div = document.createElement("div");
      div.className = SIGNATURE_CLASS;
      div.innerHTML = signature;
      el.appendChild(div);
    }
    setD((x) => ({ ...x, withSignature: on }));
  };
  const addFiles = (list: FileList | File[]) => setD((x) => ({ ...x, files: [...x.files, ...Array.from(list)].slice(0, 10) }));

  const send = useMutation({
    mutationFn: async () => {
      const bad = [...d.to, ...d.cc, ...d.bcc].find((a) => !isAddress(a));
      if (bad) throw new Error(t("outlook.errors.invalid_address", { address: bad }));
      if (!d.to.length) throw new Error(t("outlook.errors.no_recipient"));
      const attachments = await Promise.all(
        d.files.map(async (f) => ({ name: f.name, contentType: f.type || "application/octet-stream", data: await fileToBase64(f) })),
      );
      const payload = {
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        html: editor.current?.html() ?? "",
        attachments,
        importance: d.importance,
        readReceipt: d.readReceipt,
      };
      if (mode === "new") return api.post(`${base(d.accountId)}/send`, payload);
      return api.post(`${base(d.accountId)}/messages/${encodeURIComponent(message!.id)}/respond`, { ...payload, mode });
    },
    onSuccess: () => {
      toast.success(t("outlook.sentOk"));
      void qc.invalidateQueries({ queryKey: [...KEY, "folders", d.accountId] });
      void qc.invalidateQueries({ queryKey: [...KEY, "contacts"] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof Error && !("code" in e) ? e.message : outlookErrorText(t, e)),
  });

  const title =
    mode === "new" ? t("outlook.newMail") : mode === "forward" ? t("outlook.forward") : mode === "replyAll" ? t("outlook.replyAll") : t("outlook.reply");
  const quoteDoc = message
    ? `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:12px;background:#fff;color:#111;font-family:Calibri,Arial,sans-serif;font-size:13px}img{max-width:100%;height:auto}</style></head><body>${message.html}</body></html>`
    : "";
  const originalFiles = mode === "forward" ? (message?.attachments ?? []).filter((a) => !a.isInline) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[92dvh] flex-col gap-3 sm:max-w-4xl"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="size-5 text-primary" /> {title}
          </DialogTitle>
          <DialogDescription>
            {message && mode !== "new"
              ? mode === "forward"
                ? t("outlook.forwardOf", { subject: message.subject || t("outlook.noSubject") })
                : t("outlook.replyTo", { name: who(message.from) })
              : t("outlook.recipientsHint")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-2.5"
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
          <Row label={t("outlook.to")}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <RecipientInput
                  key={`to-${round}`}
                  label={t("outlook.to")}
                  autoFocus={!d.to.length}
                  value={d.to}
                  onChange={(to) => setD((x) => ({ ...x, to }))}
                />
              </div>
              <div className="flex shrink-0 gap-1 pt-1.5 text-xs">
                {!showCc && (
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => setShowCc(true)}
                  >
                    {t("outlook.cc")}
                  </button>
                )}
                {!showBcc && (
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => setShowBcc(true)}
                  >
                    {t("outlook.bcc")}
                  </button>
                )}
              </div>
            </div>
          </Row>
          {showCc && (
            <Row label={t("outlook.cc")}>
              <RecipientInput key={`cc-${round}`} label={t("outlook.cc")} value={d.cc} onChange={(cc) => setD((x) => ({ ...x, cc }))} />
            </Row>
          )}
          {showBcc && (
            <Row label={t("outlook.bcc")}>
              <RecipientInput key={`bcc-${round}`} label={t("outlook.bcc")} autoFocus value={d.bcc} onChange={(bcc) => setD((x) => ({ ...x, bcc }))} />
            </Row>
          )}
          <Row label={t("outlook.subject")}>
            <Input maxLength={250} value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} />
          </Row>

          <RichEditor
            key={`ed-${round}`}
            ref={editor}
            initialHtml={initialHtml}
            label={t("outlook.body")}
            autoFocus={d.to.length > 0}
            minHeight="14rem"
            className={cn("min-h-[16rem] flex-1", dragging && "border-[color:var(--gold)] bg-[color:var(--gold)]/5")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send.mutate();
              }
            }}
          />

          {message && mode !== "new" && (
            <div className="rounded-lg border">
              <button
                type="button"
                onClick={() => setShowQuote((v) => !v)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={cn("size-3.5 transition-transform", showQuote && "rotate-180")} />
                {t("outlook.original", { from: who(message.from) })}
              </button>
              {showQuote && (
                <iframe
                  title={t("outlook.originalTitle")}
                  sandbox=""
                  srcDoc={quoteDoc}
                  className="h-56 w-full rounded-b-lg bg-white"
                  referrerPolicy="no-referrer"
                />
              )}
            </div>
          )}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                <Paperclip className="size-4" /> {t("outlook.attach")}
              </Button>
              <Button
                type="button"
                variant={d.importance === "high" ? "default" : "outline"}
                size="sm"
                aria-pressed={d.importance === "high"}
                className={cn(d.importance === "high" && "bg-red-500/80 text-white hover:bg-red-500")}
                onClick={() => setD({ ...d, importance: d.importance === "high" ? "normal" : "high" })}
              >
                <AlertTriangle className="size-4" /> {t("outlook.important")}
              </Button>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox checked={d.readReceipt} onCheckedChange={(v) => setD({ ...d, readReceipt: v === true })} /> {t("outlook.readReceipt")}
              </label>
              {signature ? (
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox checked={d.withSignature} onCheckedChange={(v) => toggleSignature(v === true)} /> {t("outlook.withSignature")}
                </label>
              ) : (
                <span className="text-xs text-muted-foreground">{t("outlook.noSignature")}</span>
              )}
              <span className={cn("ml-auto text-xs", tooBig ? "text-destructive" : "text-muted-foreground")}>
                {d.files.length ? `${bytes(total)} / ` : ""}
                {t("outlook.attachLimit", { size: bytes(maxBytes) })}
              </span>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  addFiles(e.target.files ?? []);
                  e.target.value = "";
                }}
              />
            </div>
            {(d.files.length > 0 || originalFiles.length > 0) && (
              <ul className="flex flex-wrap gap-1.5">
                {originalFiles.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-1.5 rounded-lg border border-dashed px-2 py-1 text-xs text-muted-foreground"
                    title={t("outlook.originalFile")}
                  >
                    <Paperclip className="size-3" />
                    <span className="max-w-48 truncate">{a.name}</span>
                    <span>{bytes(a.size)}</span>
                  </li>
                ))}
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

          <div className="flex items-center justify-end gap-2 pt-1">
            <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">{t("outlook.sendShortcut")}</span>
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
export function AddToTicketDialog({
  open,
  onOpenChange,
  accountId,
  message,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  accountId: string;
  message: MailMessage | null;
}) {
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
