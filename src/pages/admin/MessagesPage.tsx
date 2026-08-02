import { useEffect, useMemo, useState, type FormEvent } from "react";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Mail, Megaphone, Pin, Send } from "lucide-react";
import { db, dbReady, schema } from "@/db";
import { useAuth } from "@/lib/auth";
import type { BoardMessage, Company, User } from "@/lib/types";
import {
  fetchSmtpStatus,
  isBoardEmailOptedIn,
  sendBoardEmails,
  type BoardEmailRecipient,
} from "@/lib/smtp";
import { EmptyState } from "@/components/EmptyState";
import { BlurFade } from "@/components/ui/blur-fade";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export function MessagesPage() {
  const { user } = useAuth();
  const [clients, setClients] = useState<Company[]>([]);
  const [messages, setMessages] = useState<
    (BoardMessage & { companyName: string })[]
  >([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [sendEmail, setSendEmail] = useState(false);
  const [smtpReady, setSmtpReady] = useState<boolean | null>(null);
  const [filterCompany, setFilterCompany] = useState<number | "all">("all");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = async () => {
    await dbReady;
    const [companies, msgs] = await Promise.all([
      db.select().from(schema.companies),
      db
        .select()
        .from(schema.board_messages)
        .orderBy(desc(schema.board_messages.created_at)),
    ]);
    const allCompanies = companies as Company[];
    const clientCompanies = allCompanies
      .filter((c) => c.type === "client" && c.active)
      .sort((a, b) => a.name.localeCompare(b.name));
    const map = new Map(allCompanies.map((c) => [c.id, c.name] as const));
    setClients(clientCompanies);
    setMessages(
      (msgs as BoardMessage[]).map((m) => ({
        ...m,
        companyName: String(map.get(m.company_id) ?? "Unknown client"),
      })),
    );
    setLoading(false);
  };

  useEffect(() => {
    void load();
    fetchSmtpStatus(false)
      .then((s) => setSmtpReady(Boolean(s.configured && s.ok)))
      .catch(() => setSmtpReady(false));
  }, []);

  const toggleClient = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const selectAll = () => {
    if (selectedIds.length === clients.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(clients.map((c) => c.id));
    }
  };

  const collectEmailRecipients = async (
    companyIds: number[],
  ): Promise<BoardEmailRecipient[]> => {
    if (companyIds.length === 0) return [];
    await dbReady;
    const rows = (await db
      .select()
      .from(schema.users)
      .where(
        and(
          inArray(schema.users.company_id, companyIds),
          eq(schema.users.active, true),
          eq(schema.users.role, "client"),
        ),
      )) as User[];

    const companyMap = new Map(clients.map((c) => [c.id, c.name]));
    const recipients: BoardEmailRecipient[] = [];
    const seen = new Set<string>();

    for (const u of rows) {
      if (!isBoardEmailOptedIn(u.board_email_opt_in)) continue;
      const email = (u.email || "").trim().toLowerCase();
      if (!email || !email.includes("@") || seen.has(email)) continue;
      seen.add(email);
      recipients.push({
        email,
        name: u.name || email,
        companyName:
          u.company_id != null
            ? companyMap.get(u.company_id) || undefined
            : undefined,
      });
    }
    return recipients;
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (!user) return;
    if (selectedIds.length === 0) {
      setError("Select at least one client. Each board is unique per client.");
      return;
    }
    if (!title.trim() || !body.trim()) {
      setError("Title and message body are required.");
      return;
    }
    if (sendEmail && smtpReady === false) {
      setError(
        "SMTP is not configured. Open Settings → Email (SMTP) to connect a mail server, or uncheck “Also send by email”.",
      );
      return;
    }

    setSending(true);
    await dbReady;

    const titleTrim = title.trim();
    const bodyTrim = body.trim();

    // One unique message row per selected client board
    await db.insert(schema.board_messages).values(
      selectedIds.map((companyId) => ({
        company_id: companyId,
        author_id: user.id,
        author_name: user.name,
        title: titleTrim,
        body: bodyTrim,
        pinned,
      })),
    );

    const names = clients
      .filter((c) => selectedIds.includes(c.id))
      .map((c) => c.name)
      .join(", ");

    let emailNote = "";
    if (sendEmail) {
      const recipients = await collectEmailRecipients(selectedIds);
      if (recipients.length === 0) {
        emailNote =
          " No emails sent — no opted-in client users with valid addresses on the selected boards.";
      } else {
        const mail = await sendBoardEmails({
          title: titleTrim,
          body: bodyTrim,
          authorName: user.name,
          portalUrl:
            typeof window !== "undefined" ? window.location.origin : null,
          recipients,
        });
        if (mail.ok || mail.sent > 0) {
          emailNote = ` Email: ${mail.sent} private message${mail.sent === 1 ? "" : "s"} sent (one recipient per email).`;
          if (mail.failed > 0) {
            emailNote += ` ${mail.failed} failed.`;
          }
        } else {
          emailNote = ` Email failed: ${mail.error || "unknown error"}. Board posts were still saved.`;
        }
      }
    }

    setSending(false);
    setTitle("");
    setBody("");
    setPinned(false);
    setSendEmail(false);
    setSelectedIds([]);
    setSuccess(
      (selectedIds.length === 1
        ? `Message posted to ${names}'s board.`
        : `Message posted to ${selectedIds.length} unique client boards: ${names}.`) +
        emailNote,
    );
    await load();
  };

  const filteredMessages = useMemo(() => {
    if (filterCompany === "all") return messages;
    return messages.filter((m) => m.company_id === filterCompany);
  }, [messages, filterCompany]);

  const deleteMessage = async (id: number) => {
    await dbReady;
    await db
      .delete(schema.board_messages)
      .where(eq(schema.board_messages.id, id));
    await load();
  };

  const togglePin = async (msg: BoardMessage) => {
    await dbReady;
    await db
      .update(schema.board_messages)
      .set({ pinned: !msg.pinned })
      .where(eq(schema.board_messages.id, msg.id));
    await load();
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-5">
        <BlurFade delay={0.05} className="xl:col-span-2">
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Send className="size-5 text-primary" />
                Post to client boards
              </CardTitle>
              <CardDescription>
                Choose one or multiple clients. Communication is always unique
                per client board — the same content is written separately to
                each selected zone.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={send} className="space-y-5">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label>Recipients</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={selectAll}
                      disabled={clients.length === 0}
                    >
                      {selectedIds.length === clients.length &&
                      clients.length > 0
                        ? "Clear all"
                        : "Select all"}
                    </Button>
                  </div>
                  <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border p-3">
                    {clients.length === 0 ? (
                      <p className="py-4 text-center text-sm text-muted-foreground">
                        No active client companies. Add clients first.
                      </p>
                    ) : (
                      clients.map((client) => {
                        const checked = selectedIds.includes(client.id);
                        return (
                          <label
                            key={client.id}
                            className={cn(
                              "flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors",
                              checked ? "bg-primary/10" : "hover:bg-muted/60",
                            )}
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={() => toggleClient(client.id)}
                            />
                            <span className="font-medium">{client.name}</span>
                          </label>
                        );
                      })
                    )}
                  </div>
                  {selectedIds.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {selectedIds.length} client board
                      {selectedIds.length > 1 ? "s" : ""} selected
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mtitle">Title</Label>
                  <Input
                    id="mtitle"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Service notice, update, reminder…"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mbody">Message</Label>
                  <Textarea
                    id="mbody"
                    rows={5}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Write the announcement clients will see when they sign in…"
                    required
                  />
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={pinned}
                    onCheckedChange={(v) => setPinned(v === true)}
                  />
                  Pin to top of board
                </label>

                <div
                  className={cn(
                    "rounded-lg border p-3 space-y-2",
                    sendEmail
                      ? "border-primary/40 bg-primary/5"
                      : "border-border bg-muted/20",
                  )}
                >
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={sendEmail}
                      onCheckedChange={(v) => setSendEmail(v === true)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="flex items-center gap-1.5 font-medium">
                        <Mail className="size-3.5" />
                        Also send by email
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Emails go only to client users on the selected boards
                        who opted in. Each person receives a{" "}
                        <strong>separate private email</strong> (no shared To/Cc
                        list — recipients never see each other).
                      </span>
                    </span>
                  </label>
                  {sendEmail && (
                    <p className="pl-6 text-xs text-muted-foreground">
                      {smtpReady === null && "Checking SMTP…"}
                      {smtpReady === true && (
                        <span className="text-primary">
                          SMTP ready — private delivery enabled.
                        </span>
                      )}
                      {smtpReady === false && (
                        <span className="text-destructive">
                          SMTP not configured. Set it under Settings → Email
                          (SMTP).
                        </span>
                      )}
                    </p>
                  )}
                </div>

                {error && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </div>
                )}
                {success && (
                  <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground">
                    {success}
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full gap-2"
                  disabled={sending}
                >
                  <Megaphone className="size-4" />
                  {sending
                    ? sendEmail
                      ? "Posting & emailing…"
                      : "Sending…"
                    : sendEmail
                      ? "Post boards + email"
                      : "Send to selected boards"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </BlurFade>

        <BlurFade delay={0.1} className="xl:col-span-3">
          <Card className="h-full">
            <CardHeader className="flex flex-col gap-4 space-y-0 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>All client board activity</CardTitle>
                <CardDescription>
                  Messages are stored per client — boards never mix between
                  companies.
                </CardDescription>
              </div>
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={filterCompany === "all" ? "all" : String(filterCompany)}
                onChange={(e) =>
                  setFilterCompany(
                    e.target.value === "all" ? "all" : Number(e.target.value),
                  )
                }
              >
                <option value="all">All clients</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-24 animate-pulse rounded-lg bg-muted"
                    />
                  ))}
                </div>
              ) : filteredMessages.length === 0 ? (
                <EmptyState
                  icon={<Megaphone className="size-5" />}
                  title="No board messages yet"
                  description="Post a message to one or more client boards. Each client only sees their own."
                />
              ) : (
                <ScrollArea className="h-[560px] pr-3">
                  <div className="space-y-3">
                    {filteredMessages.map((msg) => (
                      <div
                        key={msg.id}
                        className={cn(
                          "rounded-xl border p-4 transition-colors",
                          msg.pinned
                            ? "border-primary/40 bg-primary/5"
                            : "border-border bg-card/50",
                        )}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="font-semibold">{msg.title}</h3>
                              {msg.pinned && (
                                <Badge className="bg-primary text-primary-foreground hover:bg-primary">
                                  <Pin className="mr-1 size-3" />
                                  Pinned
                                </Badge>
                              )}
                            </div>
                            <Badge
                              variant="outline"
                              className="border-primary/30 text-primary"
                            >
                              {msg.companyName}
                            </Badge>
                          </div>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => togglePin(msg)}
                              title={msg.pinned ? "Unpin" : "Pin"}
                            >
                              <Pin className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => deleteMessage(msg.id)}
                            >
                              Delete
                            </Button>
                          </div>
                        </div>
                        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                          {msg.body}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>From {msg.author_name}</span>
                          <span>{formatDate(msg.created_at)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </BlurFade>
      </div>
    </div>
  );
}
