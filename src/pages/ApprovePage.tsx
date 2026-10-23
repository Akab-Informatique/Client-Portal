import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Loader2, MapPin, MonitorSmartphone, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/Logo";
import { ApiError } from "@/lib/api";
import { approve, deny, loadPending, refreshSubscription, registerWorker, storedDevice, type Pending } from "@/lib/push";

type Phase = "loading" | "nodevice" | "idle" | "pending" | "working" | "approved" | "denied" | "failed" | "gone";

/**
 * The page the phone opens when the notification is tapped (/approve?c=…): no sign-in here, the phone proves itself with
 * its device token and its passkey. It shows where the request comes from and three numbers; the person taps the one
 * shown on the computer, then unlocks the passkey (fingerprint, face or PIN).
 */
export function ApprovePage() {
  const { t } = useTranslation();
  const challengeId = new URLSearchParams(window.location.search).get("c") ?? undefined;
  const device = useRef(storedDevice());
  const [phase, setPhase] = useState<Phase>(device.current ? "loading" : "nodevice");
  const [req, setReq] = useState<Extract<Pending, { pending: true }> | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = device.current;
    if (!d) return;
    try {
      const r = await loadPending(d, challengeId);
      if (r.pending) {
        setReq(r);
        setPhase((p) => (p === "working" ? p : "pending"));
      } else {
        setReq(null);
        setPhase((p) => (p === "approved" || p === "denied" || p === "failed" ? p : "idle"));
      }
    } catch (e) {
      // a phone the server no longer knows (removed from the profile, or the authenticator was reset)
      if (e instanceof ApiError && e.status === 401) setPhase("gone");
      else setMessage(t("approve.network"));
    }
  }, [challengeId, t]);

  useEffect(() => {
    const d = device.current;
    if (!d) return;
    void registerWorker().then(() => refreshSubscription(d)).catch(() => undefined);
    void load();
    // while waiting for a request, look again every few seconds
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  async function pick(n: number) {
    if (!device.current || !req) return;
    setPhase("working");
    setMessage(null);
    try {
      await approve(device.current, req, n);
      setPhase("approved");
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      if (code === "push_wrong_number") {
        setMessage(t("approve.wrongNumber"));
        await load();
        setPhase("pending");
      } else if (code === "push_expired" || code === "push_already_answered") setPhase("failed");
      else if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError")) {
        // the person cancelled the fingerprint / face / PIN prompt
        setMessage(t("approve.cancelled"));
        setPhase("pending");
      } else {
        setMessage(t("approve.error"));
        setPhase("pending");
      }
    }
  }

  async function refuse() {
    if (!device.current || !req) return;
    setPhase("working");
    try {
      await deny(device.current, req.challengeId);
      setPhase("denied");
    } catch {
      setPhase("failed");
    }
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-[#0a0a0b] px-5 py-8 text-foreground">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <Wordmark className="h-8" />
        </div>

        {phase === "loading" && (
          <div className="flex justify-center py-10">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {phase === "nodevice" && <Notice icon={ShieldAlert} tone="warn" title={t("approve.noDevice")} text={t("approve.noDeviceText")} />}
        {phase === "gone" && <Notice icon={ShieldAlert} tone="warn" title={t("approve.gone")} text={t("approve.goneText")} />}
        {phase === "idle" && <Notice icon={ShieldCheck} tone="ok" title={t("approve.idle")} text={t("approve.idleText")} />}
        {phase === "approved" && <Notice icon={CheckCircle2} tone="ok" title={t("approve.approved")} text={t("approve.approvedText")} />}
        {phase === "denied" && <Notice icon={XCircle} tone="warn" title={t("approve.denied")} text={t("approve.deniedText")} />}
        {phase === "failed" && <Notice icon={XCircle} tone="warn" title={t("approve.failed")} text={t("approve.failedText")} />}

        {(phase === "pending" || phase === "working") && req && (
          <div className="space-y-5">
            <div className="space-y-1 text-center">
              <h1 className="text-xl font-bold">{t("approve.title")}</h1>
              <p className="text-sm text-muted-foreground">{t("approve.where")}</p>
            </div>
            <div className="space-y-2 rounded-2xl border bg-white/[0.03] p-4 text-sm">
              <p className="flex items-center gap-2">
                <MonitorSmartphone className="size-4 text-primary" /> {req.where.agent}
              </p>
              <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                <MapPin className="size-4 text-primary" /> {req.where.ip || t("approve.unknownIp")}
              </p>
              <p className="text-xs text-muted-foreground">{new Date(req.where.at).toLocaleTimeString()}</p>
            </div>
            <div className="space-y-2">
              <p className="text-center text-sm font-medium">{t("approve.pick")}</p>
              <div className="grid grid-cols-3 gap-3">
                {req.numbers.map((n) => (
                  <button
                    key={n}
                    type="button"
                    disabled={phase === "working"}
                    onClick={() => void pick(n)}
                    className="h-20 rounded-2xl border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 font-mono text-3xl font-bold text-primary transition-transform active:scale-95 disabled:opacity-50"
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            {message && <p className="text-center text-sm text-orange-300">{message}</p>}
            {phase === "working" && (
              <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {t("approve.working")}
              </p>
            )}
            <Button variant="outline" disabled={phase === "working"} onClick={() => void refuse()} className="h-12 w-full border-destructive/50 text-destructive hover:bg-destructive/10">
              {t("approve.notMe")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Notice({ icon: Icon, title, text, tone }: { icon: typeof ShieldCheck; title: string; text: string; tone: "ok" | "warn" }) {
  return (
    <div className="space-y-3 rounded-2xl border bg-white/[0.03] p-6 text-center">
      <Icon className={tone === "ok" ? "mx-auto size-10 text-emerald-400" : "mx-auto size-10 text-orange-300"} />
      <h1 className="text-lg font-bold">{title}</h1>
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}
