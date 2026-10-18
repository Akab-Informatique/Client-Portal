import { GRAPH_BASE, graph, O365Error, user } from "./o365.ts";

/**
 * Outlook module: AKAB Microsoft 365 mailboxes through Microsoft Graph,
 * with the same app registration as the calendars (application permissions
 * Mail.ReadWrite and Mail.Send, admin consent). Server side only; the routes
 * check that the mailbox belongs to the signed-in technician.
 */

/** Graph limit for one sendMail / attachment request (~4 MB with base64). */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const PAGE = 30;
/** Inline (cid:) images embedded as data: URLs when a message is opened. */
const MAX_INLINE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_TOTAL = 8 * 1024 * 1024;

export type MailAddress = { name: string | null; address: string };
export type MailFolder = { id: string; name: string; unread: number; total: number; childCount: number; wellKnown: string | null };
export type MailListItem = {
  id: string;
  subject: string;
  from: MailAddress | null;
  receivedAt: string;
  preview: string;
  isRead: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  importance: string;
};
export type MailAttachment = { id: string; name: string; contentType: string; size: number; isInline: boolean };
export type MailMessage = MailListItem & {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  html: string;
  attachments: MailAttachment[];
  folderId: string;
};
export type OutgoingAttachment = { name: string; contentType: string; data: string };

type GAddr = { emailAddress?: { name?: string; address?: string } };
type GMsg = {
  id: string;
  subject?: string;
  from?: GAddr;
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  flag?: { flagStatus?: string };
  hasAttachments?: boolean;
  importance?: string;
  toRecipients?: GAddr[];
  ccRecipients?: GAddr[];
  bccRecipients?: GAddr[];
  replyTo?: GAddr[];
  body?: { contentType?: string; content?: string };
  parentFolderId?: string;
};

const addr = (a?: GAddr): MailAddress | null => (a?.emailAddress?.address ? { name: a.emailAddress.name || null, address: a.emailAddress.address } : null);
const addrs = (l?: GAddr[]) => (l ?? []).map(addr).filter((x): x is MailAddress => Boolean(x));
const recipients = (l: string[]) => l.map((address) => ({ emailAddress: { address } }));
const enc = encodeURIComponent;

const LIST_FIELDS = "id,subject,from,receivedDateTime,bodyPreview,isRead,flag,hasAttachments,importance";

function listItem(m: GMsg): MailListItem {
  return {
    id: m.id,
    subject: m.subject || "",
    from: addr(m.from),
    receivedAt: m.receivedDateTime ?? "",
    preview: (m.bodyPreview ?? "").slice(0, 200),
    isRead: Boolean(m.isRead),
    flagged: m.flag?.flagStatus === "flagged",
    hasAttachments: Boolean(m.hasAttachments),
    importance: m.importance ?? "normal",
  };
}

/** Linking check: the app can read this mailbox (Mail permission granted, mailbox exists). */
export async function testMailbox(mailbox: string): Promise<{ displayName: string | null }> {
  const r = await graph<{ displayName?: string }>("GET", `${user(mailbox)}?$select=displayName`).catch((e) => {
    // users/{x} needs User.Read.All; the mailbox itself is what matters
    if (e instanceof O365Error && e.code === "forbidden") return { displayName: undefined };
    throw e;
  });
  await graph("GET", `${user(mailbox)}/mailFolders/inbox?$select=id`);
  return { displayName: r.displayName ?? null };
}

const WELL_KNOWN = ["inbox", "drafts", "sentitems", "deleteditems", "archive", "junkemail"] as const;

/** Top-level folders (or the sub-folders of one), well-known folders first. */
export async function listFolders(mailbox: string, parentId?: string): Promise<MailFolder[]> {
  type F = { id: string; displayName?: string; unreadItemCount?: number; totalItemCount?: number; childFolderCount?: number };
  const q = "$top=100&$select=id,displayName,unreadItemCount,totalItemCount,childFolderCount";
  const base = parentId ? `${user(mailbox)}/mailFolders/${enc(parentId)}/childFolders` : `${user(mailbox)}/mailFolders`;
  const r = await graph<{ value: F[] }>("GET", `${base}?${q}`);
  const folders = (r.value ?? []).map((f) => ({
    id: f.id,
    name: f.displayName || "—",
    unread: f.unreadItemCount ?? 0,
    total: f.totalItemCount ?? 0,
    childCount: f.childFolderCount ?? 0,
    wellKnown: null as string | null,
  }));
  if (parentId) return folders;
  // Recognise the well-known folders (their names are localized by Outlook)
  const known = await Promise.all(
    WELL_KNOWN.map((w) =>
      graph<{ id: string }>("GET", `${user(mailbox)}/mailFolders/${w}?$select=id`)
        .then((f) => [w, f.id] as const)
        .catch(() => null),
    ),
  );
  const order = new Map<string, number>();
  for (const [i, k] of known.entries()) {
    if (!k) continue;
    const f = folders.find((x) => x.id === k[1]);
    if (f) {
      f.wellKnown = k[0];
      order.set(f.id, i);
    }
  }
  return folders.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99) || a.name.localeCompare(b.name));
}

/**
 * Messages of a folder, newest first, or a search in it. `cursor` is the
 * opaque next page returned before (Graph's nextLink, kept to this mailbox).
 */
export async function listMessages(
  mailbox: string,
  folderId: string,
  opts: { search?: string; cursor?: string } = {},
): Promise<{ items: MailListItem[]; next: string | null }> {
  const own = `${user(mailbox)}/`;
  let path: string;
  if (opts.cursor) {
    // Only a page of this same mailbox, as returned by Graph
    const resolved = (p: string) => new URL(GRAPH_BASE + p).pathname.toLowerCase();
    if (
      !opts.cursor.toLowerCase().startsWith(own.toLowerCase()) ||
      opts.cursor.includes("..") ||
      /[\x00-\x20\x7f]/.test(opts.cursor) ||
      !resolved(opts.cursor).startsWith(resolved(own))
    ) {
      throw new O365Error("not_found");
    }
    path = opts.cursor;
  } else {
    const q = new URLSearchParams({ $top: String(PAGE), $select: LIST_FIELDS });
    const search = (opts.search ?? "").trim().slice(0, 120);
    if (search) q.set("$search", `"${search.replace(/["\\]/g, " ")}"`);
    else q.set("$orderby", "receivedDateTime desc");
    path = `${own}mailFolders/${enc(folderId)}/messages?${q}`;
  }
  const r = await graph<{ value: GMsg[]; "@odata.nextLink"?: string }>("GET", path);
  const nextLink = r["@odata.nextLink"];
  const next = nextLink?.startsWith(GRAPH_BASE) ? nextLink.slice(GRAPH_BASE.length) : null;
  return { items: (r.value ?? []).map(listItem), next };
}

/** One message with its HTML body (inline images embedded) and attachment list. */
export async function getMessage(mailbox: string, id: string): Promise<MailMessage> {
  const base = `${user(mailbox)}/messages/${enc(id)}`;
  const m = await graph<GMsg>(
    "GET",
    `${base}?$select=${LIST_FIELDS},toRecipients,ccRecipients,bccRecipients,replyTo,body,parentFolderId`,
    undefined,
    undefined,
    ['outlook.body-content-type="html"'],
  );
  type A = { "@odata.type"?: string; id: string; name?: string; contentType?: string; size?: number; isInline?: boolean; contentId?: string };
  const list =
    m.hasAttachments || /cid:/i.test(m.body?.content ?? "")
      ? ((await graph<{ value: A[] }>("GET", `${base}/attachments?$select=id,name,contentType,size,isInline`)).value ?? [])
      : [];
  let html = m.body?.contentType === "text" ? textToHtml(m.body?.content ?? "") : (m.body?.content ?? "");
  // cid: images → data: URLs (the reading pane is a sandboxed frame without cookies)
  let budget = MAX_INLINE_TOTAL;
  for (const a of list) {
    if (!a.isInline || !(a.contentType ?? "").startsWith("image/") || (a.size ?? 0) > MAX_INLINE_BYTES || (a.size ?? 0) > budget) continue;
    const full = await graph<A & { contentBytes?: string }>("GET", `${base}/attachments/${enc(a.id)}`).catch(() => null);
    if (!full?.contentBytes || !full.contentId) continue;
    budget -= a.size ?? 0;
    const cid = full.contentId.replace(/^<|>$/g, "");
    html = html.split(`cid:${cid}`).join(`data:${a.contentType};base64,${full.contentBytes}`);
  }
  return {
    ...listItem(m),
    to: addrs(m.toRecipients),
    cc: addrs(m.ccRecipients),
    bcc: addrs(m.bccRecipients),
    replyTo: addrs(m.replyTo),
    html,
    folderId: m.parentFolderId ?? "",
    // Inline images are shown in the body; the rest are listed as files
    attachments: list
      .filter((a) => !(a.isInline && (a.contentType ?? "").startsWith("image/")))
      .map((a) => ({
        id: a.id,
        name: a.name || "attachment",
        contentType: a.contentType || "application/octet-stream",
        size: a.size ?? 0,
        isInline: Boolean(a.isInline),
      })),
  };
}

/** Plain-text version of a message, for a ticket note. */
export async function messageText(mailbox: string, id: string): Promise<MailMessage & { text: string }> {
  const m = await graph<GMsg>("GET", `${user(mailbox)}/messages/${enc(id)}?$select=${LIST_FIELDS},toRecipients,ccRecipients,body`, undefined, undefined, [
    'outlook.body-content-type="text"',
  ]);
  return {
    ...listItem(m),
    to: addrs(m.toRecipients),
    cc: addrs(m.ccRecipients),
    bcc: [],
    replyTo: [],
    html: "",
    attachments: [],
    folderId: "",
    text: (m.body?.content ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}

/**
 * Mark every unread message of a folder as read (Graph has no single call
 * for it: pages of unread ids, patched 20 at a time with $batch). Returns how
 * many were marked; stops after `max`.
 */
export async function markFolderRead(mailbox: string, folderId: string, max = 2000): Promise<number> {
  const root = user(mailbox);
  let done = 0;
  while (done < max) {
    const page = await graph<{ value: { id: string }[] }>("GET", `${root}/mailFolders/${enc(folderId)}/messages?$filter=isRead eq false&$select=id&$top=100`);
    const ids = (page.value ?? []).map((m) => m.id);
    if (!ids.length) break;
    for (let i = 0; i < ids.length; i += 20) {
      const requests = ids.slice(i, i + 20).map((id, n) => ({
        id: String(n + 1),
        method: "PATCH",
        url: `/${root}/messages/${enc(id)}`,
        headers: { "Content-Type": "application/json" },
        body: { isRead: true },
      }));
      const r = await graph<{ responses?: { status: number }[] }>("POST", "$batch", { requests });
      const ok = (r.responses ?? []).filter((x) => x.status >= 200 && x.status < 300).length;
      done += ok;
      // nothing changes (e.g. no right to write): stop rather than loop
      if (!ok) return done;
    }
  }
  return done;
}

/**
 * Empty a folder: its messages go to Deleted Items; in Deleted Items itself
 * they are deleted. Pages of ids, 20 per $batch. Returns how many; stops
 * after `max`.
 */
export async function emptyFolder(mailbox: string, folderId: string, max = 5000): Promise<number> {
  const root = user(mailbox);
  const trash = await graph<{ id: string }>("GET", `${root}/mailFolders/deleteditems?$select=id`)
    .then((f) => f.id)
    .catch(() => null);
  const inTrash = folderId.toLowerCase() === "deleteditems" || folderId === trash;
  let done = 0;
  while (done < max) {
    const page = await graph<{ value: { id: string }[] }>("GET", `${root}/mailFolders/${enc(folderId)}/messages?$select=id&$top=100`);
    const ids = (page.value ?? []).map((m) => m.id);
    if (!ids.length) break;
    let ok = 0;
    for (let i = 0; i < ids.length; i += 20) {
      const requests = ids
        .slice(i, i + 20)
        .map((id, n) =>
          inTrash
            ? { id: String(n + 1), method: "DELETE", url: `/${root}/messages/${enc(id)}` }
            : {
                id: String(n + 1),
                method: "POST",
                url: `/${root}/messages/${enc(id)}/move`,
                headers: { "Content-Type": "application/json" },
                body: { destinationId: "deleteditems" },
              },
        );
      const r = await graph<{ responses?: { status: number }[] }>("POST", "$batch", { requests });
      ok += (r.responses ?? []).filter((x) => x.status >= 200 && x.status < 300).length;
    }
    done += ok;
    // nothing went (no right to write…): stop rather than loop
    if (!ok) break;
  }
  return done;
}

/** A new folder (top level, or inside another one). */
export async function createFolder(mailbox: string, name: string, parentId?: string): Promise<MailFolder> {
  const path = parentId ? `${user(mailbox)}/mailFolders/${enc(parentId)}/childFolders` : `${user(mailbox)}/mailFolders`;
  const f = await graph<{ id: string; displayName?: string }>("POST", path, { displayName: name });
  return { id: f.id, name: f.displayName ?? name, unread: 0, total: 0, childCount: 0, wellKnown: null };
}
export async function renameFolder(mailbox: string, id: string, name: string): Promise<void> {
  await graph("PATCH", `${user(mailbox)}/mailFolders/${enc(id)}`, { displayName: name });
}
/** Outlook's own folders (ids), which cannot be deleted nor moved. */
async function ownFolderIds(mailbox: string): Promise<(string | null)[]> {
  return Promise.all(
    [...WELL_KNOWN, "outbox"].map((w) =>
      graph<{ id: string }>("GET", `${user(mailbox)}/mailFolders/${w}?$select=id`)
        .then((f) => f.id)
        .catch(() => null),
    ),
  );
}
const isOwnFolder = (own: (string | null)[], id: string) => own.includes(id) || ([...WELL_KNOWN, "outbox"] as string[]).includes(id.toLowerCase());

/** Move a folder inside another one, or back to the top of the mailbox ("root"). */
export async function moveFolder(mailbox: string, id: string, destination: string | "root"): Promise<string> {
  if (destination === id) throw new O365Error("forbidden", "same_folder");
  if (isOwnFolder(await ownFolderIds(mailbox), id)) throw new O365Error("forbidden", "protected_folder");
  const r = await graph<{ id: string }>("POST", `${user(mailbox)}/mailFolders/${enc(id)}/move`, {
    destinationId: destination === "root" ? "msgfolderroot" : destination,
  });
  return r.id;
}

/** Deleting a folder moves it (and its messages) to Deleted Items, like Outlook. Outlook's own folders stay. */
export async function deleteFolder(mailbox: string, id: string): Promise<void> {
  if (isOwnFolder(await ownFolderIds(mailbox), id)) throw new O365Error("forbidden", "protected_folder");
  await graph("DELETE", `${user(mailbox)}/mailFolders/${enc(id)}`);
}

export async function updateMessage(mailbox: string, id: string, p: { isRead?: boolean; flagged?: boolean }): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (p.isRead !== undefined) patch.isRead = p.isRead;
  if (p.flagged !== undefined) patch.flag = { flagStatus: p.flagged ? "flagged" : "notFlagged" };
  await graph("PATCH", `${user(mailbox)}/messages/${enc(id)}`, patch);
}

/** Move to a folder id or a well-known name ("archive", "deleteditems"…). Returns the new id. */
export async function moveMessage(mailbox: string, id: string, destination: string): Promise<string> {
  const r = await graph<{ id: string }>("POST", `${user(mailbox)}/messages/${enc(id)}/move`, { destinationId: destination });
  return r.id;
}

/** A file attachment's bytes (item / link attachments cannot be downloaded). */
export async function attachment(mailbox: string, id: string, attachmentId: string): Promise<{ name: string; contentType: string; bytes: Buffer }> {
  const a = await graph<{ "@odata.type"?: string; name?: string; contentType?: string; contentBytes?: string }>(
    "GET",
    `${user(mailbox)}/messages/${enc(id)}/attachments/${enc(attachmentId)}`,
  );
  if (a["@odata.type"] !== "#microsoft.graph.fileAttachment" || !a.contentBytes) throw new O365Error("not_found");
  return { name: a.name || "attachment", contentType: a.contentType || "application/octet-stream", bytes: Buffer.from(a.contentBytes, "base64") };
}

const fileAttachment = (a: OutgoingAttachment) => ({
  "@odata.type": "#microsoft.graph.fileAttachment",
  name: a.name,
  contentType: a.contentType || "application/octet-stream",
  contentBytes: a.data,
});

export type Outgoing = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** Sanitized HTML (our text, signature included) */
  html: string;
  attachments: OutgoingAttachment[];
  importance: "low" | "normal" | "high";
  readReceipt: boolean;
};

/** New message, saved in Sent Items. */
export async function sendMail(mailbox: string, m: Outgoing): Promise<void> {
  await graph("POST", `${user(mailbox)}/sendMail`, {
    message: {
      subject: m.subject,
      body: { contentType: "HTML", content: wrap(m.html) },
      toRecipients: recipients(m.to),
      ccRecipients: recipients(m.cc),
      bccRecipients: recipients(m.bcc),
      importance: m.importance,
      isReadReceiptRequested: m.readReceipt,
      attachments: m.attachments.map(fileAttachment),
    },
    saveToSentItems: true,
  });
}

/**
 * Reply / reply all / forward: Outlook builds the draft (quoted original and,
 * for a forward, its files); we put our text above the quote, set the
 * recipients, subject and options chosen in the window, add files, then send.
 */
export async function respond(mailbox: string, id: string, mode: "reply" | "replyAll" | "forward", m: Outgoing): Promise<void> {
  const action = mode === "reply" ? "createReply" : mode === "replyAll" ? "createReplyAll" : "createForward";
  const draft = await graph<{ id: string; subject?: string; body?: { contentType?: string; content?: string } }>(
    "POST",
    `${user(mailbox)}/messages/${enc(id)}/${action}`,
    {},
  );
  const draftPath = `${user(mailbox)}/messages/${enc(draft.id)}`;
  try {
    await graph("PATCH", draftPath, {
      toRecipients: recipients(m.to),
      ccRecipients: recipients(m.cc),
      bccRecipients: recipients(m.bcc),
      ...(m.subject.trim() ? { subject: m.subject } : {}),
      importance: m.importance,
      isReadReceiptRequested: m.readReceipt,
      body: { contentType: "HTML", content: abovequote(wrap(m.html), draft.body) },
    });
    for (const a of m.attachments) await graph("POST", `${draftPath}/attachments`, fileAttachment(a));
    await graph("POST", `${draftPath}/send`);
  } catch (e) {
    // Do not leave a half-built draft behind
    await graph("DELETE", draftPath).catch(() => undefined);
    throw e;
  }
}

/** Our part in the default Outlook font. */
const wrap = (html: string) => `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">${html}</div>`;

/** Our part placed above the quoted original in the draft Outlook made. */
function abovequote(ours: string, body?: { contentType?: string; content?: string }): string {
  const quoted = body?.content ?? "";
  if (!quoted) return ours;
  const html = body?.contentType?.toLowerCase() === "text" ? `<pre>${esc(quoted)}</pre>` : quoted;
  const at = html.search(/<body[^>]*>/i);
  if (at < 0) return `${ours}<br>${html}`;
  const close = html.indexOf(">", at) + 1;
  return `${html.slice(0, close)}${ours}<br>${html.slice(close)}`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The technician's text as a simple HTML body (paragraphs and line breaks kept). */
export function textToHtml(text: string): string {
  const body = esc(text).replace(/\r\n/g, "\n").replace(/\n/g, "<br>");
  return `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">${body}</div>`;
}
