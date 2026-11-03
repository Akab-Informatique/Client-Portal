import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Copy, CreditCard, FileCheck2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { brandName } from "@/pages/crm/ContractAutopay";
import { shortDate } from "@/pages/tickets/shared";

type Status = "active" | "pending" | "failed" | "revoked";
type Row = {
  id: string;
  clientId: string;
  client: string;
  contracts: { id: string; name: string }[];
  status: Status;
  email: string | null;
  requestedAt: string;
  revokedAt: string | null;
  accepted: { name: string | null; at: string; ip: string | null; text: string | null } | null;
  card: { brand: string | null; last4: string; expMonth: number | null; expYear: number | null; funding: string | null } | null;
  live: boolean;
  lastChargeAt: string | null;
  lastError: string | null;
  url: string | null;
};
type Filter = "all" | "active" | "pending" | "failed" | "revoked";

const STATUS_CLASS: Record<Status, string> = {
  active: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  pending: "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary",
  failed: "border-red-500/40 bg-red-500/10 text-red-300",
  revoked: "border-border text-muted-foreground",
};

/** A card that expires within two months (or already has) */
const expiresSoon = (c: Row["card"]) => {
  if (!c?.expMonth || !c.expYear) return false;
  const end = new Date(c.expYear, c.expMonth, 0);
  return end.getTime() - Date.now() < 61 * 86_400_000;
};
const dateTime = (iso: string, lang: string) => new Date(iso).toLocaleString(lang === "en" ? "en-CA" : "fr-CA", { dateStyle: "long", timeStyle: "short" });

/**
 * Accounting › Contrats › Paiements par carte: every link sent for automatic card payment, one row per link (the
 * contracts it covers), where it stands, who accepted it and when, the card and the last charge; the proof of the
 * acceptance (name, day and hour, IP, the exact text) opens in a window.
 */
export function CardAutopays() {
  const { t, i18n } = useTranslation();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["crm", "autopay-overview"], queryFn: () => api.get<Row[]>("/autopay/overview") });
  const [filter, setFilter] = useState<Filter>("all");
  const [proof, setProof] = useState<Row | null>(null);
  const counts: Record<Filter, number> = {
    all: rows.filter((r) => r.status !== "revoked").length,
    active: rows.filter((r) => r.status === "active").length,
    pending: rows.filter((r) => r.status === "pending").length,
    failed: rows.filter((r) => r.status === "failed").length,
    revoked: rows.filter((r) => r.status === "revoked").length,
  };
  const shown = rows.filter((r) => (filter === "all" ? r.status !== "revoked" : r.status === filter));
  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url).catch(() => undefined);
    toast.success(t("autopay.copied"));
  };

  return (
    <div className="space-y-3">
      <div className="glass flex flex-wrap gap-1 rounded-2xl border p-2">
        {(["all", "active", "pending", "failed", "revoked"] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn("flex h-9 items-center gap-1.5 rounded-xl border px-3 text-sm transition-colors", filter === f ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")}
          >
            {t(`cardList.filter.${f}`)} <span className="font-mono text-[11px] text-muted-foreground">{counts[f]}</span>
          </button>
        ))}
      </div>

      {isLoading && <Loader2 className="mx-auto my-10 size-5 animate-spin text-muted-foreground" />}
      {!isLoading && shown.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">{t("cardList.none")}</p>}
      {shown.length > 0 && (
        <div className="glass overflow-x-auto rounded-2xl border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="px-4 py-2.5 font-medium">{t("cardList.client")}</th>
                <th className="px-3 py-2.5 font-medium">{t("cardList.status")}</th>
                <th className="px-3 py-2.5 font-medium">{t("cardList.accepted")}</th>
                <th className="px-3 py-2.5 font-medium">{t("cardList.card")}</th>
                <th className="px-3 py-2.5 font-medium">{t("cardList.lastCharge")}</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {shown.map((r) => (
                <tr key={r.id} className={cn(r.status === "revoked" && "opacity-60")}>
                  <td className="px-4 py-2.5">
                    <Link to={`/crm/${r.clientId}?tab=contracts`} className="font-medium hover:text-primary hover:underline">
                      {r.client}
                    </Link>
                    <span className="block max-w-72 truncate text-xs text-muted-foreground" title={r.contracts.map((k) => k.name).join(", ")}>
                      {r.contracts.map((k) => k.name).join(", ")}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={cn("inline-block rounded-md border px-1.5 py-0.5 text-[11px] font-semibold", STATUS_CLASS[r.status])}>{t(`cardList.state.${r.status}`)}</span>
                    {!r.live && r.card && <span className="ml-1 text-[10px] text-muted-foreground">{t("autopay.testMode")}</span>}
                    <span className="block text-[11px] text-muted-foreground">
                      {r.status === "pending" ? t("cardList.sentOn", { date: shortDate(r.requestedAt.slice(0, 10)), to: r.email ?? "—" }) : r.status === "revoked" && r.revokedAt ? t("cardList.revokedOn", { date: shortDate(r.revokedAt.slice(0, 10)) }) : ""}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    {r.accepted ? (
                      <>
                        <span className="block">{r.accepted.name}</span>
                        <span className="block text-xs text-muted-foreground">{dateTime(r.accepted.at, i18n.language)}</span>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("cardList.notYet")}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {r.card ? (
                      <>
                        <span className="flex items-center gap-1.5">
                          <CreditCard className="size-3.5 text-muted-foreground" /> {brandName(r.card.brand)} •••• {r.card.last4}
                        </span>
                        <span className={cn("block text-xs", expiresSoon(r.card) && r.status !== "revoked" ? "text-amber-300" : "text-muted-foreground")}>
                          {r.card.expMonth && r.card.expYear && t("autopay.expires", { date: `${String(r.card.expMonth).padStart(2, "0")}/${String(r.card.expYear).slice(-2)}` })}
                          {expiresSoon(r.card) && r.status !== "revoked" && ` · ${t("cardList.expiresSoon")}`}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {r.lastChargeAt ? <span className="text-xs">{shortDate(r.lastChargeAt.slice(0, 10))}</span> : <span className="text-xs text-muted-foreground">{t("autopay.never")}</span>}
                    {r.lastError && (
                      <span className="mt-0.5 flex items-start gap-1 text-xs text-red-300" title={r.lastError}>
                        <AlertTriangle className="mt-0.5 size-3 shrink-0" /> <span className="line-clamp-2">{r.lastError}</span>
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">
                    {r.url && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void copy(r.url!)}>
                        <Copy className="size-3.5" /> {t("autopay.copy")}
                      </Button>
                    )}
                    {r.accepted && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setProof(r)}>
                        <FileCheck2 className="size-3.5" /> {t("cardList.proof")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {proof?.accepted && (
        <Dialog open onOpenChange={(o) => !o && setProof(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t("cardList.proofTitle")}</DialogTitle>
              <DialogDescription>
                {proof.client} · {proof.contracts.map((k) => k.name).join(", ")}
              </DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("cardList.proofName")}</dt>
              <dd className="font-medium">{proof.accepted.name}</dd>
              <dt className="text-muted-foreground">{t("cardList.proofWhen")}</dt>
              <dd>{dateTime(proof.accepted.at, i18n.language)}</dd>
              <dt className="text-muted-foreground">{t("cardList.proofIp")}</dt>
              <dd className="font-mono">{proof.accepted.ip ?? "—"}</dd>
              <dt className="text-muted-foreground">{t("cardList.proofEmail")}</dt>
              <dd>{proof.email ?? "—"}</dd>
              {proof.card && (
                <>
                  <dt className="text-muted-foreground">{t("cardList.card")}</dt>
                  <dd>
                    {brandName(proof.card.brand)} •••• {proof.card.last4}
                  </dd>
                </>
              )}
            </dl>
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">{t("cardList.proofText")}</p>
              <p className="rounded-xl border bg-background/40 p-3 text-sm leading-relaxed">{proof.accepted.text}</p>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
