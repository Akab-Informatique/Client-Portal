import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Copy, Eye, EyeOff, KeyRound, Loader2, Lock, ShieldCheck, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/brand/Logo";
import { LiveDot, TechBackground } from "@/components/brand/TechBackground";
import { LanguageToggle } from "@/components/LanguageToggle";
import { api, ApiError } from "@/lib/api";
import { signOut, useRefreshAuth } from "@/lib/session";
import type { Stage } from "@/lib/types";
import { cn } from "@/lib/utils";

export function LoginPage({ stage, email }: { stage: Stage; email?: string }) {
  const { t } = useTranslation();
  return (
    <div className="relative grid min-h-dvh lg:grid-cols-[1.15fr_1fr]">
      <Hero />
      <div className="relative flex flex-col bg-background">
        <div className="flex items-center justify-between p-5 lg:justify-end">
          <Logo className="lg:hidden" />
          <LanguageToggle />
        </div>
        <div className="flex flex-1 items-center justify-center px-5 pb-12">
          <div className="w-full max-w-sm">
            <AnimatePresence mode="wait">
              <motion.div
                key={stage}
                initial={{ opacity: 0, y: 14, filter: "blur(6px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -10, filter: "blur(6px)" }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              >
                {stage === "anonymous" && <CredentialsStep />}
                {stage === "mfa-setup" && <MfaSetupStep email={email} />}
                {stage === "mfa" && <MfaChallengeStep email={email} />}
                {stage === "password" && <PasswordStep />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        <p className="flex items-center justify-center gap-2 pb-6 text-xs text-muted-foreground">
          <Lock className="size-3.5" /> {t("login.secure")}
        </p>
      </div>
    </div>
  );
}

// ── Left hero ────────────────────────────────────────────────────────────────
function Hero() {
  const { t } = useTranslation();
  const rows = [
    { label: t("login.statusNetwork"), value: t("login.operational") },
    { label: t("login.statusBackups"), value: t("login.upToDate") },
    { label: t("login.statusSecurity"), value: t("login.protected") },
    { label: t("login.statusSupport"), value: t("login.available") },
  ];
  return (
    <div className="dark relative hidden overflow-hidden bg-[#0a0a0b] text-[#ededf0] lg:flex lg:flex-col">
      <TechBackground />
      <div className="relative z-10 p-10">
        <Logo />
      </div>
      <div className="relative z-10 mt-auto max-w-xl px-10 pb-14 xl:px-16">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-[#9a9ca4] backdrop-blur"
        >
          <LiveDot tone="gold" /> {t("login.tagline")} — Lanaudière
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="text-5xl font-extrabold leading-[1.02] xl:text-6xl"
        >
          {t("login.heroTitle")} <span className="text-grad-gold">{t("login.heroTitleAccent")}</span>
        </motion.h1>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
          className="mt-5 max-w-md text-lg text-[#9a9ca4]"
        >
          {t("login.heroText")}
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="mt-10 rounded-2xl border border-white/10 bg-[#121317]/80 p-5 shadow-2xl backdrop-blur-xl"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-[#9a9ca4]">
              <LiveDot /> {t("login.live")}
            </div>
            <span className="font-mono text-xs text-[#9a9ca4]">24 / 7</span>
          </div>
          <div className="mt-3 flex items-baseline gap-3">
            <span className="font-display text-4xl font-bold text-grad-gold">99,98%</span>
            <span className="text-xs text-[#9a9ca4]">{t("login.uptime")}</span>
          </div>
          <UptimeBars />
          <div className="mt-4 grid grid-cols-2 gap-2">
            {rows.map((r, i) => (
              <motion.div
                key={r.label}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.7 + i * 0.08 }}
                className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs"
              >
                <span className="text-[#9a9ca4]">{r.label}</span>
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <span className="size-1.5 rounded-full bg-emerald-400" /> {r.value}
                </span>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function UptimeBars() {
  const bars = Array.from({ length: 42 }, (_, i) => (i === 17 ? 0.55 : 0.75 + ((i * 37) % 25) / 100));
  return (
    <div className="mt-3 flex h-8 items-end gap-[3px]" aria-hidden="true">
      {bars.map((h, i) => (
        <motion.span
          key={i}
          className={cn("w-full rounded-sm", i === 17 ? "bg-amber-500/70" : "bg-grad-gold opacity-80")}
          initial={{ scaleY: 0 }}
          animate={{ scaleY: 1 }}
          style={{ height: `${h * 100}%`, transformOrigin: "bottom" }}
          transition={{ delay: 0.6 + i * 0.012, duration: 0.4 }}
        />
      ))}
    </div>
  );
}

// ── Steps ────────────────────────────────────────────────────────────────────
function StepHeader({ icon: Icon, title, text }: { icon: typeof Lock; title: string; text: string }) {
  return (
    <div className="mb-7">
      <div className="mb-5 inline-flex size-11 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204] glow-gold">
        <Icon className="size-5" />
      </div>
      <h2 className="text-3xl font-bold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function errorText(t: (k: string) => string, e: unknown, fallback: string) {
  if (e instanceof ApiError) {
    if (e.status === 429) return t("login.rateLimited");
    if (e.code === "invalid_credentials") return t("login.invalid");
    if (e.code === "invalid_code") return t("mfa.invalid");
    if (e.code === "password_short") return t("password.short");
    if (e.code === "password_same") return t("password.same");
    if (e.code === "wrong_password") return t("password.wrong");
  }
  return fallback;
}

function FormError({ message }: { message: string | null }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.p
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {message}
        </motion.p>
      )}
    </AnimatePresence>
  );
}

function CredentialsStep() {
  const { t } = useTranslation();
  const refresh = useRefreshAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/login", { email, password });
      await refresh();
    } catch (err) {
      setError(errorText(t, err, t("common.error")));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <StepHeader icon={KeyRound} title={t("login.title")} text={t("login.subtitle")} />
      <div className="space-y-2">
        <Label htmlFor="email">{t("login.email")}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-11"
          placeholder="prenom@akab.ca"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">{t("login.password")}</Label>
        <div className="relative">
          <Input
            id="password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11 pr-11"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>
      <FormError message={error} />
      <GoldButton busy={busy}>{t("login.submit")}</GoldButton>
    </form>
  );
}

function GoldButton({ busy, children }: { busy?: boolean; children: React.ReactNode }) {
  return (
    <Button
      type="submit"
      disabled={busy}
      className="group h-11 w-full bg-grad-gold font-semibold text-[#1a1204] glow-gold transition-transform hover:brightness-105 active:scale-[0.99]"
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : children}
      {!busy && <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />}
    </Button>
  );
}

function CodeInput({ onComplete, busy }: { onComplete: (code: string) => void; busy: boolean }) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="space-y-2">
      <Label htmlFor="code">{t("mfa.code")}</Label>
      <Input
        ref={ref}
        id="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        disabled={busy}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, 6);
          setCode(v);
          if (v.length === 6) onComplete(v);
        }}
        placeholder="000000"
        className="h-14 text-center font-mono text-2xl tracking-[0.6em]"
      />
    </div>
  );
}

function BackToLogin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return (
    <button
      type="button"
      onClick={() => void signOut(qc)}
      className="mt-6 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      {t("mfa.useOther")}
    </button>
  );
}

function useVerify() {
  const { t } = useTranslation();
  const refresh = useRefreshAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function verify(code: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/mfa/verify", { code });
      await refresh();
    } catch (err) {
      setError(errorText(t, err, t("common.error")));
      setBusy(false);
    }
  }
  return { verify, busy, error };
}

function MfaChallengeStep({ email }: { email?: string }) {
  const { t } = useTranslation();
  const { verify, busy, error } = useVerify();
  return (
    <div className="space-y-5">
      <StepHeader icon={ShieldCheck} title={t("mfa.challengeTitle")} text={t("mfa.challengeText")} />
      {email && <p className="-mt-3 font-mono text-xs text-muted-foreground">{email}</p>}
      <CodeInput key={error ?? "c"} onComplete={verify} busy={busy} />
      <FormError message={error} />
      <p className="text-xs text-muted-foreground">{t("mfa.lostDevice")}</p>
      <BackToLogin />
    </div>
  );
}

function MfaSetupStep({ email }: { email?: string }) {
  const { t } = useTranslation();
  const { verify, busy, error } = useVerify();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api.post<{ secret: string; qr: string }>("/auth/mfa/setup").then(setSetup, () => undefined);
  }, []);
  return (
    <div className="space-y-5">
      <StepHeader icon={Smartphone} title={t("mfa.setupTitle")} text={t("mfa.setupText")} />
      {email && <p className="-mt-3 font-mono text-xs text-muted-foreground">{email}</p>}
      <div className="flex items-center gap-4 rounded-xl border bg-card p-4">
        <div className="flex size-[132px] shrink-0 items-center justify-center rounded-lg bg-white p-1.5">
          {setup ? <img src={setup.qr} alt="QR code" className="size-full" /> : <Loader2 className="size-5 animate-spin text-neutral-500" />}
        </div>
        <div className="min-w-0 text-xs">
          <p className="text-muted-foreground">{t("mfa.manualKey")}</p>
          <p className="mt-1 break-all font-mono text-[11px] leading-relaxed">{setup?.secret.match(/.{1,4}/g)?.join(" ")}</p>
          {setup && (
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1 text-primary hover:underline"
              onClick={() => {
                void navigator.clipboard.writeText(setup.secret);
                setCopied(true);
              }}
            >
              <Copy className="size-3" /> {copied ? t("common.copied") : t("common.copy")}
            </button>
          )}
        </div>
      </div>
      <CodeInput key={error ?? "s"} onComplete={verify} busy={busy || !setup} />
      <FormError message={error} />
      <BackToLogin />
    </div>
  );
}

function PasswordStep() {
  const { t } = useTranslation();
  const refresh = useRefreshAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) return setError(t("password.mismatch"));
    if (next.length < 12) return setError(t("password.short"));
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/password", { current, next });
      await refresh();
    } catch (err) {
      setError(errorText(t, err, t("common.error")));
      setBusy(false);
    }
  }

  const strength = Math.min(4, Math.floor(next.length / 4));
  return (
    <form onSubmit={submit} className="space-y-4">
      <StepHeader icon={Lock} title={t("password.title")} text={t("password.text")} />
      <div className="space-y-2">
        <Label htmlFor="cur">{t("password.current")}</Label>
        <Input id="cur" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} className="h-11" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="new">{t("password.next")}</Label>
        <Input id="new" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} className="h-11" />
        <div className="flex gap-1" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={cn("h-1 flex-1 rounded-full transition-colors", i < strength ? "bg-grad-gold" : "bg-muted")} />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("password.rule")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="conf">{t("password.confirm")}</Label>
        <Input id="conf" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-11" />
      </div>
      <FormError message={error} />
      <GoldButton busy={busy}>{t("password.submit")}</GoldButton>
      <BackToLogin />
    </form>
  );
}
