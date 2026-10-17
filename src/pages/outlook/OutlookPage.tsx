import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, ArrowDown, ArrowLeft, ArrowUp, ChevronDown, ChevronRight, Download, Eye, EyeOff, Flag, Folder, FolderInput, Forward, Inbox, Loader2, Mail, MailOpen, MoreHorizontal, Paperclip, Plus, Reply, ReplyAll, Search, Send, ShieldAlert, SlidersHorizontal, Star, StarOff, Ticket, TicketPlus, Trash2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { dateTime } from "@/lib/format";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { NewTicketDialog } from "@/pages/tickets/NewTicketDialog";
import type { TicketList } from "@/pages/tickets/shared";
import { AddToTicketDialog, ComposeDialog, LinkMailboxDialog } from "./dialogs";
import {
  base,
  bytes,
  foldersKey,
  KEY,
  messageKey,
  messagesKey,
  outlookErrorText,
  patchListItem,
  removeListItem,
  statusKey,
  who,
  type ComposeMode,
  type MailAccount,
  type MailFolder,
  type MailMessage,
  type MailPage,
  type OutlookStatus,
} from "./shared";

const FOLDER_ICON: Record<string, typeof Inbox> = { inbox: Inbox, sentitems: Send, deleteditems: Trash2, archive: Archive, drafts: Mail, junkemail: ShieldAlert };

/** Today: the time; this year: day and month; older: the date. */
function listDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const loc = currentLocale() === "en" ? "en-CA" : "fr-CA";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(loc, { day: "numeric", month: "short" });
  return d.toLocaleDateString(loc);
}

export function OutlookPage() {
  const me = useMe();
  return me.preferences.outlook ? <OutlookMail /> : <OutlookOff />;
}

/** The module is off: one click turns it on (or from the profile). */
function OutlookOff() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const on = useMutation({
    mutationFn: () => api.put("/me/preferences", { outlook: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["auth"] }),
    onError: () => toast.error(t("common.error")),
  });
  return (
    <EmptyCard
      icon={Mail}
      title={t("profile.outlookOffTitle")}
      text={t("profile.outlookOffText")}
      action={
        <Button className="bg-grad-gold font-semibold text-[#1a1204]" disabled={on.isPending} onClick={() => on.mutate()}>
          {on.isPending ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />} {t("profile.outlookTurnOn")}
        </Button>
      }
    />
  );
}

function OutlookMail() {
  const { t } = useTranslation();
  const msSignIn = useMutation({
    mutationFn: () => api.post<{ url: string }>("/microsoft/connect", {}),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: () => toast.error(t("common.error")),
  });
  const status = useQuery({ queryKey: statusKey, queryFn: () => api.get<OutlookStatus>("/outlook/status") });
  const [linkOpen, setLinkOpen] = useState(false);
  const [sel, setSel] = useState<{ account: string; folder: string } | null>(null);
  const [messageId, setMessageId] = useState<string | null>(null);
  const [compose, setCompose] = useState<{ mode: ComposeMode; message: MailMessage | null } | null>(null);

  const accounts = status.data?.accounts ?? [];
  // First mailbox's inbox by default; forget a mailbox that was removed
  useEffect(() => {
    if (!accounts.length) {
      setSel(null);
      return;
    }
    if (!sel || !accounts.some((a) => a.id === sel.account)) setSel({ account: accounts[0].id, folder: "inbox" });
  }, [accounts, sel]);
  useEffect(() => setMessageId(null), [sel?.account, sel?.folder]);

  if (status.isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const s = status.data;
  if (!s) return <p className="py-16 text-center text-muted-foreground">{t("common.error")}</p>;

  const account = accounts.find((a) => a.id === sel?.account) ?? null;

  return (
    <div className="relative isolate space-y-4">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Mail className="size-6 text-primary" /> {t("outlook.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("outlook.subtitle")}</p>
        </div>
        {s.ready && accounts.length > 0 && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-9" onClick={() => setLinkOpen(true)}>
              <Plus className="size-4" /> {t("outlook.linkMailbox")}
            </Button>
            {s.canSend && (
              <Button size="sm" className="h-9 bg-grad-gold font-semibold text-[#1a1204] glow-gold hover:brightness-105" onClick={() => setCompose({ mode: "new", message: null })}>
                <Send className="size-4" /> {t("outlook.newMail")}
              </Button>
            )}
          </div>
        )}
      </div>

      {!s.ready ? (
        <EmptyCard icon={ShieldAlert} title={t("outlook.notReady")} text={t("outlook.notReadyText")} />
      ) : !accounts.length && !s.signedIn && !s.canLinkAny ? (
        <EmptyCard
          icon={Inbox}
          title={t("outlook.noAccounts")}
          text={t("profile.ms.signInForMail")}
          action={
            <Button className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" disabled={msSignIn.isPending} onClick={() => msSignIn.mutate()}>
              {msSignIn.isPending ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />} {t("profile.ms.signIn")}
            </Button>
          }
        />
      ) : !accounts.length ? (
        <EmptyCard
          icon={Inbox}
          title={t("outlook.noAccounts")}
          text={t("outlook.noAccountsText")}
          action={
            <Button className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105" onClick={() => setLinkOpen(true)}>
              <Plus className="size-4" /> {t("outlook.linkMailbox")}
            </Button>
          }
        />
      ) : (
        <div className="grid h-[calc(100dvh-11.5rem)] min-h-[520px] gap-3 lg:grid-cols-[250px_minmax(280px,360px)_1fr]">
          <aside className={cn("glass min-h-0 overflow-y-auto rounded-2xl border p-2 scrollbar-thin", "hidden lg:block")}>
            <p className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("outlook.folders")}</p>
            {accounts.map((a, i) => (
              <AccountTree key={a.id} account={a} defaultOpen={i === 0} selected={sel} onSelect={(folder) => setSel({ account: a.id, folder })} />
            ))}
          </aside>

          {sel && account && (
            <>
              <MessageList
                account={account}
                accounts={accounts}
                folder={sel.folder}
                onFolder={(folder, acc) => setSel({ account: acc ?? account.id, folder })}
                selectedId={messageId}
                onOpen={setMessageId}
                className={messageId ? "hidden lg:flex" : "flex"}
              />
              <section className={cn("glass min-h-0 flex-col overflow-hidden rounded-2xl border", messageId ? "flex" : "hidden lg:flex")}>
                {messageId ? (
                  <MessageView
                    key={`${account.id}:${messageId}`}
                    account={account}
                    messageId={messageId}
                    canSend={s.canSend}
                    onClose={() => setMessageId(null)}
                    onCompose={(mode, message) => setCompose({ mode, message })}
                  />
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                    <MailOpen className="size-8 opacity-50" />
                    {t("outlook.select")}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      )}

      <LinkMailboxDialog open={linkOpen} onOpenChange={setLinkOpen} status={s} onLinked={(a) => setSel({ account: a.id, folder: "inbox" })} />
      {account && (
        <ComposeDialog
          open={Boolean(compose)}
          onOpenChange={(o) => !o && setCompose(null)}
          mode={compose?.mode ?? "new"}
          accounts={accounts}
          accountId={account.id}
          message={compose?.message ?? null}
          maxBytes={s.maxAttachmentBytes}
        />
      )}
    </div>
  );
}

function EmptyCard({ icon: Icon, title, text, action }: { icon: typeof Inbox; title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="glass flex flex-col items-center gap-3 rounded-2xl border px-6 py-16 text-center">
      <Icon className="size-9 text-primary" />
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="max-w-lg text-sm text-muted-foreground">{text}</p>
      {action}
    </div>
  );
}

/** One linked mailbox: expandable, with its folders (sub-folders on demand). */
type FolderPrefs = { pinned: { id: string; name: string }[]; hidden: string[] };
type Layout = {
  editing: boolean;
  pinned: (id: string) => boolean;
  hidden: (id: string) => boolean;
  togglePin: (f: MailFolder) => void;
  toggleHide: (id: string) => void;
};

function AccountTree({ account, defaultOpen, selected, onSelect }: { account: MailAccount; defaultOpen: boolean; selected: { account: string; folder: string } | null; onSelect: (folder: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = useState(defaultOpen);
  const [editing, setEditing] = useState(false);
  const folders = useQuery({ queryKey: foldersKey(account.id), queryFn: () => api.get<MailFolder[]>(`${base(account.id)}/folders`), enabled: open, staleTime: 30_000 });
  const unlink = useMutation({
    mutationFn: () => api.del(`/outlook/accounts/${account.id}`),
    onSuccess: () => {
      toast.success(t("outlook.unlinked"));
      void qc.invalidateQueries({ queryKey: statusKey });
      qc.removeQueries({ queryKey: [...KEY, "folders", account.id] });
    },
    onError: (e) => toast.error(outlookErrorText(t, e)),
  });
  // the layout is saved at once (and shown before the answer)
  const prefs: FolderPrefs = account.folderPrefs ?? { pinned: [], hidden: [] };
  const savePrefs = useMutation({
    mutationFn: (p: FolderPrefs) => api.put<FolderPrefs>(`${base(account.id)}/folder-prefs`, p),
    onMutate: (p) => {
      qc.setQueryData<OutlookStatus>(statusKey, (s) => (s ? { ...s, accounts: s.accounts.map((a) => (a.id === account.id ? { ...a, folderPrefs: p } : a)) } : s));
    },
    onError: (e) => {
      toast.error(outlookErrorText(t, e));
      void qc.invalidateQueries({ queryKey: statusKey });
    },
  });
  const layout: Layout = {
    editing,
    pinned: (id) => prefs.pinned.some((p) => p.id === id),
    hidden: (id) => prefs.hidden.includes(id),
    togglePin: (fo) =>
      savePrefs.mutate({ ...prefs, pinned: prefs.pinned.some((p) => p.id === fo.id) ? prefs.pinned.filter((p) => p.id !== fo.id) : [...prefs.pinned, { id: fo.id, name: fo.name }] }),
    toggleHide: (id) => savePrefs.mutate({ ...prefs, hidden: prefs.hidden.includes(id) ? prefs.hidden.filter((x) => x !== id) : [...prefs.hidden, id] }),
  };
  const moveFav = (i: number, d: -1 | 1) => {
    const next = [...prefs.pinned];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    savePrefs.mutate({ ...prefs, pinned: next });
  };
  const root = folders.data ?? [];
  const shown = root.filter((fo) => editing || !layout.hidden(fo.id));
  const hiddenCount = root.filter((fo) => layout.hidden(fo.id)).length;
  return (
    <div className="mb-1">
      <div className="group flex items-center gap-1 rounded-lg px-1 py-1 hover:bg-accent/40">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-semibold" aria-expanded={open}>
          {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
          <span className="min-w-0">
            <span className="block truncate">{account.displayName || account.address}</span>
            {account.displayName && <span className="block truncate text-[11px] font-normal text-muted-foreground">{account.address}</span>}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="rounded p-1 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100" aria-label={t("outlook.accountMenu")}>
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                setOpen(true);
                setEditing(true);
              }}
            >
              <SlidersHorizontal className="size-4" /> {t("outlook.layout.edit")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={async () => {
                if (await confirm({ title: t("outlook.unlinkConfirm", { address: account.address }), destructive: true })) unlink.mutate();
              }}
            >
              <Unlink className="size-4" /> {t("outlook.unlink")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && (
        <div className="ml-2 border-l pl-1">
          {editing && (
            <div className="mb-1 flex items-center gap-2 rounded-lg border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/[0.06] px-2 py-1.5 text-[11px] text-muted-foreground">
              <span className="flex-1">{t("outlook.layout.hint")}</span>
              <Button type="button" size="sm" className="h-6 bg-grad-gold px-2 text-[11px] font-semibold text-[#1a1204]" onClick={() => setEditing(false)}>
                {t("outlook.layout.done")}
              </Button>
            </div>
          )}
          {/* favourites, in the technician's order */}
          {prefs.pinned.length > 0 && (
            <div className="mb-1 border-b pb-1">
              <p className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("outlook.layout.favourites")}</p>
              {prefs.pinned.map((p, i) => {
                const live = root.find((fo) => fo.id === p.id);
                const active = selected?.account === account.id && selected.folder === p.id;
                return (
                  <div key={p.id} className={cn("flex items-center rounded-lg text-sm", active ? "bg-[color:var(--gold)]/10 text-foreground" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground")}>
                    <button type="button" onClick={() => onSelect(p.id)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 pr-2 text-left">
                      <Star className="size-3.5 shrink-0 fill-[color:var(--gold)] text-[color:var(--gold)]" />
                      <span className={cn("truncate", (live?.unread ?? 0) > 0 && "font-semibold text-foreground")}>{live?.name ?? p.name}</span>
                      {!editing && (live?.unread ?? 0) > 0 && <span className="ml-auto rounded-full bg-grad-gold px-1.5 text-[10px] font-bold text-[#1a1204]">{live!.unread}</span>}
                    </button>
                    {editing && (
                      <span className="flex shrink-0 items-center pr-1">
                        <IconToggle label={t("outlook.layout.up")} onClick={() => moveFav(i, -1)} disabled={i === 0}>
                          <ArrowUp className="size-3.5" />
                        </IconToggle>
                        <IconToggle label={t("outlook.layout.down")} onClick={() => moveFav(i, 1)} disabled={i === prefs.pinned.length - 1}>
                          <ArrowDown className="size-3.5" />
                        </IconToggle>
                        <IconToggle label={t("outlook.layout.unpin")} onClick={() => layout.togglePin({ id: p.id, name: p.name } as MailFolder)}>
                          <StarOff className="size-3.5" />
                        </IconToggle>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {folders.isLoading && <Loader2 className="m-2 size-4 animate-spin text-muted-foreground" />}
          {folders.isError && <p className="px-2 py-1 text-xs text-destructive">{outlookErrorText(t, folders.error)}</p>}
          {shown.map((fo) => (
            <FolderNode key={fo.id} accountId={account.id} folder={fo} selected={selected} onSelect={onSelect} layout={layout} />
          ))}
          {!editing && hiddenCount > 0 && (
            <button type="button" onClick={() => setEditing(true)} className="px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
              {t("outlook.layout.hiddenCount", { count: hiddenCount })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function IconToggle({ label, onClick, disabled, active, children }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn("rounded p-1 hover:bg-accent disabled:opacity-30", active ? "text-[color:var(--gold)]" : "text-muted-foreground hover:text-foreground")}
    >
      {children}
    </button>
  );
}

function FolderNode({ accountId, folder, selected, onSelect, layout, depth = 0 }: { accountId: string; folder: MailFolder; selected: { account: string; folder: string } | null; onSelect: (folder: string) => void; layout: Layout; depth?: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const kids = useQuery({ queryKey: foldersKey(accountId, folder.id), queryFn: () => api.get<MailFolder[]>(`${base(accountId)}/folders?parent=${encodeURIComponent(folder.id)}`), enabled: open, staleTime: 30_000 });
  const active = selected?.account === accountId && (selected.folder === folder.id || (selected.folder === "inbox" && folder.wellKnown === "inbox"));
  const Icon = (folder.wellKnown && FOLDER_ICON[folder.wellKnown]) || Folder;
  const hidden = layout.hidden(folder.id);
  const pinned = layout.pinned(folder.id);
  return (
    <>
      <div
        className={cn("flex items-center rounded-lg text-sm", active ? "bg-[color:var(--gold)]/10 text-foreground" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground", hidden && "opacity-45")}
        style={{ paddingLeft: depth * 12 }}
      >
        <button type="button" className={cn("p-1", !folder.childCount && "invisible")} onClick={() => setOpen((o) => !o)} aria-label={folder.name}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <button type="button" onClick={() => onSelect(folder.id)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left">
          <Icon className={cn("size-4 shrink-0", active && "text-primary")} />
          <span className={cn("truncate", folder.unread > 0 && "font-semibold text-foreground", hidden && "line-through")}>{folder.name}</span>
          {!layout.editing && folder.unread > 0 && <span className="ml-auto rounded-full bg-grad-gold px-1.5 text-[10px] font-bold text-[#1a1204]">{folder.unread}</span>}
        </button>
        {layout.editing && (
          <span className="flex shrink-0 items-center pr-1">
            <IconToggle label={pinned ? t("outlook.layout.unpin") : t("outlook.layout.pin")} onClick={() => layout.togglePin(folder)} active={pinned}>
              <Star className={cn("size-3.5", pinned && "fill-current")} />
            </IconToggle>
            <IconToggle label={hidden ? t("outlook.layout.show") : t("outlook.layout.hide")} onClick={() => layout.toggleHide(folder.id)}>
              {hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </IconToggle>
          </span>
        )}
      </div>
      {open &&
        (kids.data ?? [])
          .filter((k) => layout.editing || !layout.hidden(k.id))
          .map((k) => <FolderNode key={k.id} accountId={accountId} folder={k} selected={selected} onSelect={onSelect} layout={layout} depth={depth + 1} />)}
    </>
  );
}

function MessageList({
  account,
  accounts,
  folder,
  onFolder,
  selectedId,
  onOpen,
  className,
}: {
  account: MailAccount;
  accounts: MailAccount[];
  folder: string;
  onFolder: (folder: string, account?: string) => void;
  selectedId: string | null;
  onOpen: (id: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setSearch(q.trim()), 350);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => setQ(""), [account.id, folder]);
  const list = useInfiniteQuery({
    queryKey: messagesKey(account.id, folder, search),
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ folder });
      if (search) p.set("q", search);
      if (pageParam) p.set("cursor", pageParam);
      return api.get<MailPage>(`${base(account.id)}/messages?${p}`);
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.next ?? undefined,
    refetchInterval: 60_000,
  });
  const folders = useQuery({ queryKey: foldersKey(account.id), queryFn: () => api.get<MailFolder[]>(`${base(account.id)}/folders`), staleTime: 30_000 });
  const items = useMemo(() => (list.data?.pages ?? []).flatMap((p) => p.items), [list.data]);

  return (
    <section className={cn("glass min-h-0 flex-col overflow-hidden rounded-2xl border", className)}>
      <div className="space-y-2 border-b p-2">
        {/* Mailbox / folder on small screens (the tree is hidden there) */}
        <div className="flex gap-2 lg:hidden">
          <select
            className="h-9 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm dark:bg-input/30"
            value={`${account.id}|${folder}`}
            onChange={(e) => {
              const [acc, f] = e.target.value.split("|");
              onFolder(f, acc);
            }}
          >
            {accounts.map((a) => (
              <optgroup key={a.id} label={a.address}>
                {a.id === account.id ? (
                  (folders.data ?? []).map((f) => (
                    <option key={f.id} value={`${a.id}|${f.wellKnown === "inbox" && folder === "inbox" ? "inbox" : f.id}`}>
                      {f.name}
                      {f.unread ? ` (${f.unread})` : ""}
                    </option>
                  ))
                ) : (
                  <option value={`${a.id}|inbox`}>{t("outlook.title")} — {a.address}</option>
                )}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-9 pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("outlook.search")} />
        </div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {list.isLoading && (
          <li className="flex justify-center py-10">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </li>
        )}
        {list.isError && <li className="p-4 text-sm text-destructive">{outlookErrorText(t, list.error)}</li>}
        {!list.isLoading && !list.isError && !items.length && <li className="py-10 text-center text-sm text-muted-foreground">{t("outlook.empty")}</li>}
        {items.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => onOpen(m.id)}
              className={cn(
                "relative flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left transition-colors",
                selectedId === m.id ? "bg-[color:var(--gold)]/10" : "hover:bg-accent/40",
              )}
            >
              {!m.isRead && <span className="absolute left-0 top-3 bottom-3 w-0.5 rounded-r bg-grad-gold" />}
              <span className="flex items-center gap-2">
                <span className={cn("min-w-0 flex-1 truncate text-sm", !m.isRead ? "font-semibold" : "text-foreground/85")}>{who(m.from)}</span>
                {m.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />}
                {m.flagged && <Flag className="size-3.5 shrink-0 fill-red-500 text-red-500" />}
                <span className="shrink-0 text-[11px] text-muted-foreground">{listDate(m.receivedAt)}</span>
              </span>
              <span className={cn("truncate text-sm", !m.isRead ? "font-medium text-primary" : "text-foreground/80")}>{m.subject || t("outlook.noSubject")}</span>
              <span className="line-clamp-2 text-xs text-muted-foreground">{m.preview}</span>
            </button>
          </li>
        ))}
        {list.hasNextPage && (
          <li className="p-2">
            <Button variant="ghost" size="sm" className="w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage && <Loader2 className="size-4 animate-spin" />} {t("outlook.loadMore")}
            </Button>
          </li>
        )}
      </ul>
    </section>
  );
}

function MessageView({
  account,
  messageId,
  canSend,
  onClose,
  onCompose,
}: {
  account: MailAccount;
  messageId: string;
  canSend: boolean;
  onClose: () => void;
  onCompose: (mode: ComposeMode, m: MailMessage) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useCan();
  const navigate = useNavigate();
  const canTicket = can("tickets.edit");
  const [toTicket, setToTicket] = useState(false);
  const [newTicket, setNewTicket] = useState<{ title: string; description: string; companyId?: number | null; contactId?: string | null } | null>(null);
  const msg = useQuery({ queryKey: messageKey(account.id, messageId), queryFn: () => api.get<MailMessage>(`${base(account.id)}/messages/${encodeURIComponent(messageId)}`) });
  const folders = useQuery({ queryKey: foldersKey(account.id), queryFn: () => api.get<MailFolder[]>(`${base(account.id)}/folders`), staleTime: 30_000 });
  // Facets (priorities, queues, technicians) for the new-ticket form
  const facets = useQuery({ queryKey: ["tickets", "view=mine"], queryFn: () => api.get<TicketList>("/tickets?view=mine"), enabled: Boolean(newTicket), staleTime: 15_000 });

  // Opening marks it as read: reflect it in the list and the folder counts
  useEffect(() => {
    if (msg.data) {
      patchListItem(qc, account.id, messageId, { isRead: true });
      void qc.invalidateQueries({ queryKey: [...KEY, "folders", account.id] });
    }
  }, [msg.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = msg.data;
  const path = `${base(account.id)}/messages/${encodeURIComponent(messageId)}`;
  const patch = useMutation({
    mutationFn: (p: { isRead?: boolean; flagged?: boolean }) => api.patch(path, p).then(() => p),
    onSuccess: (p) => {
      patchListItem(qc, account.id, messageId, p);
      qc.setQueryData<MailMessage>(messageKey(account.id, messageId), (x) => (x ? { ...x, ...p } : x));
      void qc.invalidateQueries({ queryKey: [...KEY, "folders", account.id] });
      if (p.isRead === false) onClose();
    },
    onError: (e) => toast.error(outlookErrorText(t, e)),
  });
  const move = useMutation({
    mutationFn: (destination: string) => (destination === "deleteditems" ? api.del(path) : api.post(`${path}/move`, { destination })).then(() => destination),
    onSuccess: (destination) => {
      toast.success(destination === "deleteditems" ? t("outlook.deleted") : destination === "archive" ? t("outlook.archived") : t("outlook.moved"));
      removeListItem(qc, account.id, messageId);
      void qc.invalidateQueries({ queryKey: [...KEY, "folders", account.id] });
      onClose();
    },
    onError: (e) => toast.error(outlookErrorText(t, e)),
  });
  const prefill = useMutation({
    mutationFn: () =>
      api.get<{ subject: string; from: { name: string | null; address: string } | null; receivedAt: string; text: string; contact: { contactId: string; companyId: number; contactName: string; companyName: string } | null }>(`${path}/text`),
    onSuccess: (x) =>
      setNewTicket({
        companyId: x.contact?.companyId ?? null,
        contactId: x.contact?.contactId ?? null,
        title: x.subject || t("outlook.noSubject"),
        description: `${t("outlook.fromEmail", { from: x.from ? `${x.from.name ?? ""} <${x.from.address}>`.trim() : "—", date: x.receivedAt ? dateTime(x.receivedAt) : "—" })}\n\n${x.text}`,
      }),
    onError: (e) => toast.error(outlookErrorText(t, e)),
  });

  const srcDoc = useMemo(
    () =>
      m
        ? `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;background:#fff;color:#111}body{padding:16px;font-family:"Segoe UI",Calibri,Arial,sans-serif;font-size:14px;line-height:1.45;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}blockquote{margin-left:8px;padding-left:8px;border-left:2px solid #ccc}</style></head><body>${m.html}</body></html>`
        : "",
    [m],
  );
  const remoteImages = Boolean(m && /<img[^>]+src=["']?https?:/i.test(m.html));

  if (msg.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!m) return <p className="p-6 text-sm text-destructive">{outlookErrorText(t, msg.error)}</p>;

  const Action = ({ icon: Icon, label, onClick, disabled }: { icon: typeof Reply; label: string; onClick: () => void; disabled?: boolean }) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" onClick={onClick} disabled={disabled} aria-label={label}>
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
  const busy = patch.isPending || move.isPending;
  const others = (folders.data ?? []).filter((f) => f.id !== m.folderId);

  return (
    <>
      <div className="flex flex-wrap items-center gap-0.5 border-b px-2 py-1.5">
        <Button variant="ghost" size="icon" className="size-8 lg:hidden" onClick={onClose} aria-label={t("outlook.back")}>
          <ArrowLeft className="size-4" />
        </Button>
        {canSend && (
          <>
            <Action icon={Reply} label={t("outlook.reply")} onClick={() => onCompose("reply", m)} />
            <Action icon={ReplyAll} label={t("outlook.replyAll")} onClick={() => onCompose("replyAll", m)} />
            <Action icon={Forward} label={t("outlook.forward")} onClick={() => onCompose("forward", m)} />
            <span className="mx-1 h-5 w-px bg-border" />
          </>
        )}
        <Action icon={MailOpen} label={t("outlook.markUnread")} onClick={() => patch.mutate({ isRead: false })} disabled={busy} />
        <Action icon={Flag} label={m.flagged ? t("outlook.unflag") : t("outlook.flag")} onClick={() => patch.mutate({ flagged: !m.flagged })} disabled={busy} />
        <Action icon={Archive} label={t("outlook.archive")} onClick={() => move.mutate("archive")} disabled={busy} />
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" disabled={busy} aria-label={t("outlook.moveTo")}>
                  <FolderInput className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("outlook.moveTo")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            <DropdownMenuLabel>{t("outlook.moveTo")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {others.map((f) => (
              <DropdownMenuItem key={f.id} onSelect={() => move.mutate(f.id)}>
                <Folder className="size-4" /> {f.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Action icon={Trash2} label={t("outlook.delete")} onClick={() => move.mutate("deleteditems")} disabled={busy} />
        {canTicket && (
          <span className="ml-auto flex items-center gap-1.5">
            <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => setToTicket(true)}>
              <Ticket className="size-3.5" /> {t("outlook.toTicket")}
            </Button>
            <Button type="button" size="sm" className="h-8 gap-1.5 bg-grad-gold text-xs font-semibold text-[#1a1204] hover:brightness-105" onClick={() => prefill.mutate()} disabled={prefill.isPending}>
              {prefill.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <TicketPlus className="size-3.5" />} {t("outlook.newTicket")}
            </Button>
          </span>
        )}
      </div>

      <div className="space-y-1 border-b px-4 py-3">
        <h2 className="text-lg font-semibold leading-snug">{m.subject || t("outlook.noSubject")}</h2>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
          <span>
            <span className="font-medium">{who(m.from)}</span>
            {m.from?.name && <span className="text-muted-foreground"> &lt;{m.from.address}&gt;</span>}
          </span>
          <span className="text-xs text-muted-foreground">{m.receivedAt ? dateTime(m.receivedAt) : ""}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {t("outlook.to")} : {m.to.map(who).join(", ") || "—"}
          {m.cc.length > 0 && ` · ${t("outlook.cc")} : ${m.cc.map(who).join(", ")}`}
        </p>
        {m.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1.5">
            {m.attachments.map((a) => (
              <a
                key={a.id}
                href={`/api${path}/attachments/${encodeURIComponent(a.id)}`}
                download={a.name}
                className="flex items-center gap-1.5 rounded-lg border bg-card/60 px-2 py-1 text-xs hover:border-[color:var(--gold)]/50"
              >
                <Download className="size-3.5 text-primary" />
                <span className="max-w-52 truncate">{a.name}</span>
                <span className="text-muted-foreground">{bytes(a.size)}</span>
              </a>
            ))}
          </div>
        )}
        {remoteImages && <p className="pt-1 text-[11px] text-muted-foreground">{t("outlook.remoteImages")}</p>}
      </div>

      {/* Untrusted HTML: sandboxed frame (no scripts, no access to the portal), links open in a new tab */}
      <iframe title={m.subject || "email"} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={srcDoc} className="min-h-0 w-full flex-1 bg-white" referrerPolicy="no-referrer" />

      <AddToTicketDialog open={toTicket} onOpenChange={setToTicket} accountId={account.id} message={m} />
      {newTicket && facets.data && (
        <NewTicketDialog
          open
          onOpenChange={(o) => !o && setNewTicket(null)}
          facets={facets.data.facets}
          initial={newTicket}
          onCreated={(id) => navigate(`/tickets?ticket=${id}`)}
        />
      )}
    </>
  );
}
