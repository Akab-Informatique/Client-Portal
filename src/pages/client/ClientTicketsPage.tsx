import { useCallback, useEffect, useState, type FormEvent } from "react";
import { eq } from "drizzle-orm";
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  ExternalLink,
  Loader2,
  MessageSquare,
  Phone,
  PhoneCall,
  RefreshCw,
  Send,
  Ticket,
  XCircle,
} from "lucide-react";
import { db, dbReady, schema } from "@/db";
import { useAuth } from "@/lib/auth";
import {
  closeTicket,
  fetchOpenTickets,
  fetchTicketDetail,
  formatApiError,
  replyToTicket,
} from "@/lib/autotask";
import {
  buildElevationNoteBody,
  ELEVATION_NOTE_TITLE,
  SUPPORT_HOURS,
  SUPPORT_PHONE_DISPLAY,
  SUPPORT_PHONE_TEL,
} from "@/lib/support";
import type {
  AutotaskTicket,
  AutotaskTicketNote,
  Company,
} from "@/lib/types";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useLocale } from "@/hooks/use-locale";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

function priorityTone(label: string | null | undefined) {
  const l = (label ?? "").toLowerCase();
  if (l.includes("critical") || l.includes("urgent") || l.includes("high")) {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }
  if (l.includes("medium") || l.includes("normal")) {
    return "border-primary/40 bg-primary/10 text-primary";
  }
  return "border-border bg-muted/50 text-muted-foreground";
}

function isClosedStatus(label: string | null | undefined) {
  const l = (label ?? "").toLowerCase();
  return (
    l.includes("complete") ||
    l.includes("closed") ||
    l.includes("canceled") ||
    l.includes("cancelled")
  );
}

export function ClientTicketsPage() {
  const { user } = useAuth();
  const { t } = useLocale();
  const [company, setCompany] = useState<Company | null>(null);
  const [tickets, setTickets] = useState<AutotaskTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mock, setMock] = useState(false);
  const [configured, setConfigured] = useState(false);

  // Detail sheet
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailTicket, setDetailTicket] = useState<AutotaskTicket | null>(null);
  const [notes, setNotes] = useState<AutotaskTicketNote[]>([]);

  // Reply
  const [replyText, setReplyText] = useState("");
  const [replying, setReplying] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replySuccess, setReplySuccess] = useState<string | null>(null);

  // Close confirm
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeNote, setCloseNote] = useState("");
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  // Elevation request
  const [elevateOpen, setElevateOpen] = useState(false);
  const [elevating, setElevating] = useState(false);
  const [elevateError, setElevateError] = useState<string | null>(null);

  const loadCompany = useCallback(async () => {
    if (!user?.company_id) return null;
    await dbReady;
    const rows = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, user.company_id))
      .limit(1);
    const c = (rows[0] as Company | undefined) ?? null;
    setCompany(c);
    return c;
  }, [user?.company_id]);

  const loadTickets = useCallback(
    async (c: Company | null, soft = false) => {
      if (!c) {
        setTickets([]);
        setLoading(false);
        return;
      }
      if (!c.autotask_company_id) {
        setTickets([]);
        setError(
          "Your company is not linked to Autotask yet. Ask AKAB to set the Autotask Company ID on your client profile.",
        );
        setMock(false);
        setConfigured(false);
        setLoading(false);
        setRefreshing(false);
        return;
      }
      if (!user?.email) {
        setTickets([]);
        setError("You must be signed in to view your tickets.");
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (soft) setRefreshing(true);
      else setLoading(true);
      setError(null);

      const res = await fetchOpenTickets({
        companyId: c.id,
        autotaskCompanyId: c.autotask_company_id,
        email: user.email,
        scope: "user",
      });

      setTickets(res.tickets ?? []);
      setMock(Boolean(res.mock));
      setConfigured(Boolean(res.configured));
      // Always coerce — Autotask sometimes returns {code,id,message} objects
      const errText = res.error
        ? formatApiError(res.error, "Failed to load tickets")
        : null;
      if (errText && !(res.tickets && res.tickets.length)) {
        setError(errText);
      } else if (errText && res.mock) {
        setError(errText);
      } else if (res.contactMatched === false) {
        setError(
          errText ||
            `No Autotask contact matches ${user.email}. Only tickets linked to your contact are shown.`,
        );
      } else {
        setError(null);
      }
      setLoading(false);
      setRefreshing(false);
    },
    [user?.email],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const c = await loadCompany();
      if (cancelled) return;
      await loadTickets(c);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadCompany, loadTickets]);

  const onRefresh = async () => {
    const c = company ?? (await loadCompany());
    await loadTickets(c, true);
  };

  const openTicket = async (ticket: AutotaskTicket) => {
    if (!company?.autotask_company_id || !user?.email) return;
    setSelectedId(ticket.id);
    setDetailOpen(true);
    setDetailLoading(true);
    setDetailError(null);
    setDetailTicket(ticket);
    setNotes([]);
    setReplyText("");
    setReplyError(null);
    setReplySuccess(null);
    setCloseError(null);

    const res = await fetchTicketDetail({
      ticketId: ticket.id,
      autotaskCompanyId: company.autotask_company_id,
      email: user.email,
    });

    setDetailLoading(false);
    const detailErr = res.error
      ? formatApiError(res.error, "Failed to load ticket")
      : null;
    if (detailErr && !res.ticket) {
      setDetailError(detailErr);
      return;
    }
    if (res.ticket) setDetailTicket(res.ticket);
    setNotes(res.notes ?? []);
    if (detailErr) setDetailError(detailErr);
  };

  const handleReply = async (e: FormEvent) => {
    e.preventDefault();
    if (!detailTicket || !company?.autotask_company_id || !user?.email) return;
    const text = replyText.trim();
    if (!text) {
      setReplyError("Write a short message before sending.");
      return;
    }
    setReplying(true);
    setReplyError(null);
    setReplySuccess(null);

    const res = await replyToTicket({
      ticketId: detailTicket.id,
      autotaskCompanyId: company.autotask_company_id,
      email: user.email,
      description: text,
      title: "Client reply",
    });

    setReplying(false);
    if (!res.ok) {
      setReplyError(formatApiError(res.error, "Could not post your reply."));
      return;
    }

    setReplyText("");
    setReplySuccess(t("tickets.sendReply"));

    // Prefer payload notes (mock); otherwise reload detail
    if (res.notes) {
      setNotes(res.notes);
      if (res.ticket) setDetailTicket(res.ticket);
    } else {
      const refreshed = await fetchTicketDetail({
        ticketId: detailTicket.id,
        autotaskCompanyId: company.autotask_company_id,
        email: user.email,
      });
      if (refreshed.ticket) setDetailTicket(refreshed.ticket);
      setNotes(refreshed.notes ?? []);
    }

    // Soft-refresh list so last activity updates
    await loadTickets(company, true);
  };

  const handleClose = async () => {
    if (!detailTicket || !company?.autotask_company_id || !user?.email) return;
    setClosing(true);
    setCloseError(null);

    const res = await closeTicket({
      ticketId: detailTicket.id,
      autotaskCompanyId: company.autotask_company_id,
      email: user.email,
      resolution:
        closeNote.trim() || "Closed by client via the AKAB portal.",
    });

    setClosing(false);
    if (!res.ok) {
      setCloseError(formatApiError(res.error, "Could not close this ticket."));
      return;
    }

    if (res.ticket) setDetailTicket(res.ticket);
    if (res.notes) setNotes(res.notes);
    setCloseOpen(false);
    setCloseNote("");
    setReplySuccess("Ticket closed.");

    // Remove from open list
    setTickets((prev) => prev.filter((t) => t.id !== detailTicket.id));
    await loadTickets(company, true);
  };

  const handleElevate = async () => {
    if (!detailTicket || !company?.autotask_company_id || !user?.email) return;
    setElevating(true);
    setElevateError(null);

    const description = buildElevationNoteBody({
      ticketNumber: detailTicket.ticketNumber,
      userName: user.name,
      userEmail: user.email,
    });

    const res = await replyToTicket({
      ticketId: detailTicket.id,
      autotaskCompanyId: company.autotask_company_id,
      email: user.email,
      description,
      title: ELEVATION_NOTE_TITLE,
    });

    setElevating(false);
    if (!res.ok) {
      setElevateError(
        formatApiError(res.error, "Could not send the elevation request."),
      );
      return;
    }

    setElevateOpen(false);
    setReplySuccess(
      "Elevation request sent. Our team will prioritize this ticket. For true emergencies, call the support line.",
    );

    if (res.notes) {
      setNotes(res.notes);
      if (res.ticket) setDetailTicket(res.ticket);
    } else {
      const refreshed = await fetchTicketDetail({
        ticketId: detailTicket.id,
        autotaskCompanyId: company.autotask_company_id,
        email: user.email,
      });
      if (refreshed.ticket) setDetailTicket(refreshed.ticket);
      setNotes(refreshed.notes ?? []);
    }

    await loadTickets(company, true);
  };

  const ticketClosed = isClosedStatus(detailTicket?.statusLabel);

  return (
    <div className="space-y-6">
      <BlurFade delay={0.05}>
        <Card>
          <CardHeader className="flex flex-col gap-4 space-y-0 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Ticket className="size-5 text-primary" />
                {t("tickets.title")}
              </CardTitle>
              <CardDescription className="mt-1.5">
                {t("tickets.desc")}
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={loading || refreshing || !company?.autotask_company_id}
            >
              <RefreshCw
                className={cn("size-4", refreshing && "animate-spin")}
              />
              {t("tickets.refresh")}
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {mock && (
              <div className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-primary" />
                <div>
                  <p className="font-semibold">Demo tickets</p>
                  <p className="text-xs text-muted-foreground">
                    Autotask API credentials are not configured on this portal
                    yet. Showing sample open tickets — open one to try reply and
                    close. Once{" "}
                    <code className="rounded bg-muted px-1">AUTOTASK_*</code>{" "}
                    secrets are added, this list will pull live data from your
                    PSA.
                  </p>
                </div>
              </div>
            )}

            {!mock && configured && company?.autotask_company_id && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm">
                <Badge
                  variant="outline"
                  className="border-primary/40 bg-primary text-primary-foreground"
                >
                  Live Autotask
                </Badge>
                <span className="text-muted-foreground">
                  Open tickets for company ID{" "}
                  <span className="font-mono text-foreground">
                    {company.autotask_company_id}
                  </span>
                </span>
              </div>
            )}

            {error && tickets.length > 0 && (
              <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <p>{formatApiError(error)}</p>
              </div>
            )}

            {error && !loading && tickets.length === 0 && (
              <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <p className="text-destructive">{formatApiError(error)}</p>
              </div>
            )}

            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-14 animate-pulse rounded-lg bg-muted"
                  />
                ))}
              </div>
            ) : tickets.length === 0 && !error ? (
              <EmptyState
                icon={<Ticket className="size-5" />}
                title="No open tickets"
                description="There are no open Autotask tickets for your company right now."
              />
            ) : tickets.length === 0 ? null : (
              <>
                {/* Mobile cards */}
                <div className="space-y-3 md:hidden">
                  {tickets.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => openTicket(t)}
                      className={cn(
                        "w-full rounded-xl border border-border bg-card/60 p-4 text-left transition-colors",
                        "hover:border-primary/40 hover:bg-primary/5",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selectedId === t.id && detailOpen && "border-primary/50 bg-primary/5",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-muted-foreground">
                              {t.ticketNumber}
                            </span>
                            <Badge variant="outline">{t.statusLabel}</Badge>
                            {t.priorityLabel && (
                              <Badge
                                variant="outline"
                                className={priorityTone(t.priorityLabel)}
                              >
                                {t.priorityLabel}
                              </Badge>
                            )}
                          </div>
                          <p className="mt-2 font-semibold leading-snug">
                            {t.title}
                          </p>
                          {t.description && (
                            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                              {t.description}
                            </p>
                          )}
                          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <Clock className="size-3" />
                              Created {formatDate(t.createDate)}
                            </span>
                            {t.dueDateTime && (
                              <span>Due {formatDate(t.dueDateTime)}</span>
                            )}
                          </div>
                        </div>
                        <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
                      </div>
                    </button>
                  ))}
                </div>

                {/* Desktop table */}
                <div className="hidden max-h-[min(70vh,40rem)] overflow-auto overscroll-contain rounded-lg border border-border md:block">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-muted/95 backdrop-blur supports-[backdrop-filter]:bg-muted/80">
                      <TableRow className="bg-muted/40">
                        <TableHead className="w-[120px]">Ticket</TableHead>
                        <TableHead>Title</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Priority</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead>Due</TableHead>
                        <TableHead className="w-10" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tickets.map((t) => (
                        <TableRow
                          key={t.id}
                          className={cn(
                            "cursor-pointer transition-colors hover:bg-primary/5",
                            selectedId === t.id &&
                              detailOpen &&
                              "bg-primary/5",
                          )}
                          onClick={() => openTicket(t)}
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openTicket(t);
                            }
                          }}
                          aria-label={`Open ticket ${t.ticketNumber}`}
                        >
                          <TableCell className="font-mono text-xs text-primary underline-offset-2 group-hover:underline">
                            {t.ticketNumber}
                          </TableCell>
                          <TableCell>
                            <p className="font-medium">{t.title}</p>
                            {t.description && (
                              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                                {t.description}
                              </p>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{t.statusLabel}</Badge>
                          </TableCell>
                          <TableCell>
                            {t.priorityLabel ? (
                              <Badge
                                variant="outline"
                                className={priorityTone(t.priorityLabel)}
                              >
                                {t.priorityLabel}
                              </Badge>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {formatDate(t.createDate)}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {formatDate(t.dueDateTime)}
                          </TableCell>
                          <TableCell>
                            <ChevronRight className="size-4 text-muted-foreground" />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ExternalLink className="size-3" />
                  {tickets.length} open ticket
                  {tickets.length === 1 ? "" : "s"} · click a row to open · data
                  from Autotask PSA
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </BlurFade>

      {/* Ticket detail sheet — full-height column: header | scroll body | sticky footer */}
      <Sheet
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) {
            setSelectedId(null);
            setReplySuccess(null);
            setReplyError(null);
          }
        }}
      >
        <SheetContent
          side="right"
          className={cn(
            "flex h-full max-h-dvh w-full flex-col gap-0 overflow-hidden p-0",
            "sm:max-w-xl",
          )}
        >
          <SheetHeader className="shrink-0 space-y-2 border-b border-border px-6 py-5 pr-12 text-left">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {detailTicket?.ticketNumber ?? "—"}
              </span>
              {detailTicket && (
                <>
                  <Badge
                    variant="outline"
                    className={
                      ticketClosed
                        ? "border-muted-foreground/30"
                        : "border-primary/40 bg-primary/10 text-primary"
                    }
                  >
                    {detailTicket.statusLabel}
                  </Badge>
                  {detailTicket.priorityLabel && (
                    <Badge
                      variant="outline"
                      className={priorityTone(detailTicket.priorityLabel)}
                    >
                      {detailTicket.priorityLabel}
                    </Badge>
                  )}
                  {mock && (
                    <Badge variant="outline" className="text-[10px]">
                      Demo
                    </Badge>
                  )}
                </>
              )}
            </div>
            <SheetTitle className="text-left text-lg leading-snug">
              {detailTicket?.title ?? "Ticket"}
            </SheetTitle>
            <SheetDescription className="text-left">
              {detailTicket ? (
                <>
                  Created {formatDate(detailTicket.createDate)}
                  {detailTicket.dueDateTime
                    ? ` · Due ${formatDate(detailTicket.dueDateTime)}`
                    : ""}
                  {detailTicket.lastActivityDate
                    ? ` · Updated ${formatDate(detailTicket.lastActivityDate)}`
                    : ""}
                </>
              ) : (
                "Loading ticket…"
              )}
            </SheetDescription>
          </SheetHeader>

          {/* Native overflow is more reliable than Radix ScrollArea inside flex sheets */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="space-y-6 px-6 py-5 pb-8">
              {detailLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Loading details and conversation…
                </div>
              )}

              {detailError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <p>{formatApiError(detailError)}</p>
                </div>
              )}

              {detailTicket?.description && (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Description
                  </h3>
                  <div className="max-h-[40vh] overflow-y-auto overscroll-contain rounded-xl border border-border bg-muted/30 p-4 text-sm leading-relaxed whitespace-pre-wrap">
                    {detailTicket.description}
                  </div>
                </section>
              )}

              <section className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <MessageSquare className="size-3.5" />
                    Conversation
                  </h3>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {notes.length} message{notes.length === 1 ? "" : "s"} ·
                    newest first
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Only technician and client messages are shown. System and
                  internal ticket notes are hidden.
                </p>

                {detailLoading && notes.length === 0 ? (
                  <div className="space-y-2">
                    {Array.from({ length: 2 }).map((_, i) => (
                      <div
                        key={i}
                        className="h-20 animate-pulse rounded-xl bg-muted"
                      />
                    ))}
                  </div>
                ) : notes.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                    No conversation yet. Your reply will start the thread.
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {notes.map((n) => {
                      const isElevation =
                        (n.title ?? "")
                          .toLowerCase()
                          .includes("elevation") ||
                        (n.description ?? "")
                          .toLowerCase()
                          .includes("elevation requested");
                      const isYou =
                        n.fromContact ||
                        (n.description ?? "")
                          .toLowerCase()
                          .includes("client portal");
                      return (
                        <li
                          key={n.id}
                          className={cn(
                            "rounded-xl border p-4",
                            isElevation
                              ? "border-destructive/35 bg-destructive/5"
                              : isYou
                                ? "border-primary/30 bg-primary/5"
                                : "border-border bg-card",
                          )}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge
                              variant="outline"
                              className={
                                isElevation
                                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                                  : isYou
                                    ? "border-primary/40 bg-primary/15 text-primary"
                                    : ""
                              }
                            >
                              {isElevation
                                ? "Elevation"
                                : isYou
                                  ? "You"
                                  : "Technician"}
                            </Badge>
                            <span className="ml-auto text-[11px] text-muted-foreground">
                              {formatDate(n.createDateTime)}
                            </span>
                          </div>
                          <p className="mt-2 max-h-64 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
                            {displayNoteBody(n)}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {/* Elevation request */}
              {!ticketClosed && (
                <section className="space-y-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4">
                  <div className="flex items-start gap-3">
                    <ArrowUpCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <h3 className="text-sm font-semibold">
                        Need this elevated?
                      </h3>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        Request priority elevation and we&apos;ll flag this
                        ticket for faster attention. A standard elevation note
                        is posted automatically — you don&apos;t need to write
                        one.
                      </p>
                      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-background/80 px-3 py-2.5 text-xs leading-relaxed">
                        <PhoneCall className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                        <p>
                          <strong className="text-foreground">
                            Emergency?
                          </strong>{" "}
                          Do not wait on the portal. Call the AKAB support
                          line now:{" "}
                          <a
                            href={`tel:${SUPPORT_PHONE_TEL}`}
                            className="font-semibold text-foreground underline underline-offset-2"
                          >
                            {SUPPORT_PHONE_DISPLAY}
                          </a>
                          . {SUPPORT_HOURS}.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={
                          elevating ||
                          replying ||
                          closing ||
                          detailLoading
                        }
                        onClick={() => {
                          setElevateError(null);
                          setElevateOpen(true);
                        }}
                        className="mt-1 gap-2 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <ArrowUpCircle className="size-4" />
                        Request elevation
                      </Button>
                    </div>
                  </div>
                </section>
              )}

              {replySuccess && (
                <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                  <p>{replySuccess}</p>
                </div>
              )}
            </div>
          </div>

          {/* Sticky actions footer — always visible while body scrolls */}
          <div className="shrink-0 border-t border-border bg-background/95 px-6 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/85">
            {ticketClosed ? (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 shrink-0" />
                This ticket is closed. Open a new request with AKAB if you
                still need help.
              </div>
            ) : (
              <form onSubmit={handleReply} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="ticket-reply">Reply to technician</Label>
                  <Textarea
                    id="ticket-reply"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Add an update for the AKAB team…"
                    rows={3}
                    disabled={replying || detailLoading}
                    className="max-h-40 resize-y"
                  />
                </div>
                {replyError && (
                  <p className="text-xs text-destructive">{formatApiError(replyError)}</p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="submit"
                    disabled={replying || detailLoading || !replyText.trim()}
                    className="gap-2"
                  >
                    {replying ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                    {t("tickets.sendReply")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={replying || closing || elevating || detailLoading}
                    onClick={() => {
                      setCloseError(null);
                      setCloseNote("");
                      setCloseOpen(true);
                    }}
                    className="gap-2"
                  >
                    <XCircle className="size-4" />
                    {t("tickets.closeTicket")}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Close confirmation */}
      <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" />
              Confirm: close this ticket?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  You are about to mark{" "}
                  <span className="font-mono font-medium text-foreground">
                    {detailTicket?.ticketNumber}
                  </span>
                  {detailTicket?.title ? (
                    <>
                      {" "}
                      — <span className="text-foreground">{detailTicket.title}</span>
                    </>
                  ) : null}{" "}
                  as <strong className="text-foreground">Complete</strong> in
                  Autotask.
                </p>
                <p>
                  Only continue if the issue is fully resolved. Closing cannot
                  be undone from this portal — you would need AKAB to reopen
                  it.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="close-note">Closing note (optional)</Label>
            <Textarea
              id="close-note"
              value={closeNote}
              onChange={(e) => setCloseNote(e.target.value)}
              placeholder="e.g. Issue resolved after password reset."
              rows={3}
              disabled={closing}
            />
            {closeError && (
              <p className="text-xs text-destructive">{formatApiError(closeError)}</p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              disabled={closing}
              onClick={() => setCloseOpen(false)}
            >
              Keep open
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={closing}
              onClick={handleClose}
              className="gap-2"
            >
              {closing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <XCircle className="size-4" />
              )}
              Yes, close ticket
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Elevation confirmation */}
      <Dialog open={elevateOpen} onOpenChange={setElevateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowUpCircle className="size-5 text-destructive" />
              Request elevation?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  We will automatically post an elevation request on{" "}
                  <span className="font-mono font-medium text-foreground">
                    {detailTicket?.ticketNumber}
                  </span>{" "}
                  so the AKAB team prioritizes it. You do not need to write a
                  message.
                </p>
                <div className="flex items-start gap-2 rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-3 text-xs leading-relaxed text-foreground">
                  <Phone className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <p>
                    <strong>If this is an emergency</strong>, call the support
                    line instead of waiting:{" "}
                    <a
                      href={`tel:${SUPPORT_PHONE_TEL}`}
                      className="font-semibold underline underline-offset-2"
                    >
                      {SUPPORT_PHONE_DISPLAY}
                    </a>
                    . Portal elevation is for priority follow-up — not
                    life-or-business-critical outages.
                  </p>
                </div>
              </div>
            </DialogDescription>
          </DialogHeader>
          {elevateError && (
            <p className="text-xs text-destructive">{formatApiError(elevateError)}</p>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              disabled={elevating}
              onClick={() => setElevateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={elevating}
              onClick={handleElevate}
              className="gap-2"
            >
              {elevating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUpCircle className="size-4" />
              )}
              Send elevation request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Strip internal portal stamps / titles so clients only see the message. */
function displayNoteBody(n: AutotaskTicketNote): string {
  let body = (n.description ?? "").trim();
  // Remove portal attribution stamp we inject server-side
  body = body.replace(
    /^\[Client portal reply[^\]]*\]\s*/i,
    "",
  );
  body = body.replace(
    /^\[ELEVATION REQUESTED[^\]]*\]\s*/i,
    "",
  );
  body = body.trim();
  // Prefer body; fall back to title only if body empty and title isn't a system label
  if (!body && n.title) {
    const t = n.title.trim();
    if (
      !/^(ticket detail|workflow|system|status)/i.test(t) &&
      !t.toLowerCase().includes("client portal")
    ) {
      return t;
    }
  }
  return body || n.title || "(no message)";
}
