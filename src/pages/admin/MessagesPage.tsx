import { useEffect, useMemo, useState, type FormEvent } from "react";
import { desc, eq } from "drizzle-orm";
import { Megaphone, Pin, Send } from "lucide-react";
import { db, dbReady, schema } from "@/db";
import { useAuth } from "@/lib/auth";
import type { BoardMessage, Company } from "@/lib/types";
import { EmptyState } from "@/components/EmptyState";
import { BlurFade } from "@/components/ui/blur-fade";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  const [messages, setMessages] = useState<(BoardMessage & { companyName: string })[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [filterCompany, setFilterCompany] = useState<number | "all">("all");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = async () => {
    await dbReady;
    const [companies, msgs] = await Promise.all([
      db.select().from(schema.companies),
      db.select().from(schema.board_messages).orderBy(desc(schema.board_messages.created_at)),
    ]);
    const clientCompanies = (companies as Company[])
      .filter((c) => c.type === "client" && c.active)
      .sort((a, b) => a.name.localeCompare(b.name));
    const map = new Map(companies.map((c) => [c.id, c.name]));
    setClients(clientCompanies);
    setMessages(
      (msgs as BoardMessage[]).map((m) => ({
        ...m,
        companyName: map.get(m.company_id) ?? "Unknown client",
      })),
    );
    setLoading(false);
  };

  useEffect(() => {
    load();
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

    setSending(true);
    await dbReady;

    // One unique message row per selected client board
    await db.insert(schema.board_messages).values(
      selectedIds.map((companyId) => ({
        company_id: companyId,
        author_id: user.id,
        author_name: user.name,
        title: title.trim(),
        body: body.trim(),
        pinned,
      })),
    );

    const names = clients
      .filter((c) => selectedIds.includes(c.id))
      .map((c) => c.name)
      .join(", ");

    setSending(false);
    setTitle("");
    setBody("");
    setPinned(false);
    setSelectedIds([]);
    setSuccess(
      selectedIds.length === 1
        ? `Message posted to ${names}'s board.`
        : `Message posted to ${selectedIds.length} unique client boards: ${names}.`,
    );
    await load();
  };

  const filteredMessages = useMemo(() => {
    if (filterCompany === "all") return messages;
    return messages.filter((m) => m.company_id === filterCompany);
  }, [messages, filterCompany]);

  const deleteMessage = async (id: number) => {
    await dbReady;
    await db.delete(schema.board_messages).where(eq(schema.board_messages.id, id));
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
                Choose one or multiple clients. Communication is always unique per
                client board — the same content is written separately to each selected zone.
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
                      {selectedIds.length === clients.length && clients.length > 0
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

                <Button type="submit" className="w-full gap-2" disabled={sending}>
                  <Megaphone className="size-4" />
                  {sending ? "Sending…" : "Send to selected boards"}
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
                  Messages are stored per client — boards never mix between companies.
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
                    <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
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
                            <Badge variant="outline" className="border-primary/30 text-primary">
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
