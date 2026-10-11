import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, CheckCircle2, Copy, Eye, EyeOff, KeyRound, Loader2, Lock, Mail, MailCheck, ShieldCheck, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LogoMark } from "@/components/brand/Logo";
import { InteractiveBackground } from "@/components/brand/InteractiveBackground";
import { FloatingHexagons } from "@/components/brand/FloatingHexagons";
import { LanguageToggle } from "@/components/LanguageToggle";
import { api, ApiError } from "@/lib/api";
import { signOut, useRefreshAuth } from "@/lib/session";
import type { Stage } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Centered sign-in on an interactive high-tech backdrop (always dark, like akab.ca). */
type View = { kind: "login"; notice?: string } | { kind: "forgot" } | { kind: "reset"; token: string };

/** A password link from an email: /reset-password?token=… (removed from the address bar right away). */
function initialView(): View {
  const token = new URLSearchParams(window.location.search).get("token");
  if (window.location.pathname === "/reset-password" && token) {
    window.history.replaceState(null, "", "/");
    return { kind: "reset", token };
  }
  return { kind: "login" };
}

export function LoginPage({ stage, email }: { stage: Stage; email?: string }) {
  const [view, setView] = useState<View>(initialView);
  // subtle 3D tilt of the card following the mouse
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rotateX = useSpring(useTransform(my, [-0.5, 0.5], [4, -4]), { stiffness: 120, damping: 18 });
  const rotateY = useSpring(useTransform(mx, [-0.5, 0.5], [-5, 5]), { stiffness: 120, damping: 18 });

  return (
    <div
      className="dark relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#0a0a0b] px-4 py-10 text-[#ededf0]"
      onPointerMove={(e) => {
        mx.set(e.clientX / window.innerWidth - 0.5);
        my.set(e.clientY / window.innerHeight - 0.5);
      }}
      onPointerLeave={() => {
        mx.set(0);
        my.set(0);
      }}
    >
      <InteractiveBackground />
      <FloatingHexagons />
      {/* keep the card the brightest thing on screen */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_520px_420px_at_center,rgba(10,10,11,0.75),transparent_70%)]" />
      <LanguageToggle className="absolute right-4 top-4 z-20 border-white/10 bg-white/5" />

      <motion.div
        style={{ rotateX, rotateY, transformPerspective: 1100 }}
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 w-full max-w-[400px]"
      >
        {/* glowing gold edge */}
        <div className="absolute -inset-px rounded-[28px] bg-[linear-gradient(140deg,rgba(255,226,74,0.55),rgba(255,206,26,0.05)_35%,rgba(245,148,16,0.0)_60%,rgba(245,148,16,0.45))]" />
        <div className="relative rounded-[27px] border border-white/5 bg-[#101115]/80 p-8 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8),0_0_60px_-25px_rgba(255,206,26,0.35)] backdrop-blur-2xl sm:p-10">
          <Brand />
          <AnimatePresence mode="wait">
            <motion.div
              key={stage === "anonymous" ? `${stage}-${view.kind}` : stage}
              initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -8, filter: "blur(6px)" }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="mt-8"
            >
              {stage === "anonymous" && view.kind === "login" && (
                <CredentialsStep notice={view.notice} onForgot={() => setView({ kind: "forgot" })} />
              )}
              {stage === "anonymous" && view.kind === "forgot" && <ForgotStep onBack={() => setView({ kind: "login" })} />}
              {stage === "anonymous" && view.kind === "reset" && (
                <ResetStep token={view.token} onDone={(notice) => setView({ kind: "login", notice })} onNewLink={() => setView({ kind: "forgot" })} />
              )}
              {stage === "mfa-setup" && <MfaSetupStep email={email} />}
              {stage === "mfa" && <MfaChallengeStep email={email} />}
              {stage === "password" && <PasswordStep />}
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

function Brand() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center text-center">
      <motion.div
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.15, type: "spring", bounce: 0.35 }}
        className="relative"
      >
        <div className="absolute inset-0 -z-10 scale-150 rounded-full bg-[radial-gradient(circle,rgba(255,206,26,0.35),transparent_65%)] blur-xl" />
        <LogoMark className="h-16 drop-shadow-[0_0_18px_rgba(255,206,26,0.45)]" />
      </motion.div>
      <h1 className="mt-5 font-display text-[2rem] font-extrabold leading-none tracking-tight">
        <span className="text-grad-gold">AKAB</span> <span className="text-[#ededf0]">{t("login.brand")}</span>
      </h1>
    </div>
  );
}

// ── Steps ────────────────────────────────────────────────────────────────────
/** Compact header for the MFA / password steps (they need a short instruction). */
function StepHeader({ icon: Icon, title, text }: { icon: typeof Lock; title: string; text: string }) {
  return (
    <div className="mb-6 text-center">
      <div className="mx-auto mb-3 inline-flex size-9 items-center justify-center rounded-lg bg-grad-gold text-[#1a1204]">
        <Icon className="size-4" />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-xs text-[#9a9ca4]">{text}</p>
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
    if (e.code === "invalid_token") return t("reset.invalid");
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

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function CredentialsStep({ notice, onForgot }: { notice?: string; onForgot: () => void }) {
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
    <form onSubmit={submit} className="space-y-3">
      {notice && <Notice>{notice}</Notice>}
      <Label htmlFor="email" className="sr-only">{t("login.email")}</Label>
      <div className="relative">
        <Mail className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#9a9ca4]" />
        <Input
          id="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={FIELD}
          placeholder={t("login.email")}
        />
      </div>
      <Label htmlFor="password" className="sr-only">{t("login.password")}</Label>
      <div className="relative">
        <Lock className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#9a9ca4]" />
        <Input
          id="password"
          type={show ? "text" : "password"}
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={cn(FIELD, "pr-11")}
          placeholder={t("login.password")}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-[#9a9ca4] hover:text-[#ededf0]"
          aria-label={show ? "Hide password" : "Show password"}
        >
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      <div className="flex justify-end">
        <button type="button" onClick={onForgot} className="text-xs text-[#9a9ca4] transition-colors hover:text-[#ffce1a]">
          {t("login.forgot")}
        </button>
      </div>
      <FormError message={error} />
      <div className="pt-1">
        <GoldButton busy={busy}>{t("login.submit")}</GoldButton>
      </div>
    </form>
  );
}

function BackLink({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} className="mx-auto flex items-center gap-1.5 text-xs text-[#9a9ca4] transition-colors hover:text-[#ededf0]">
      <ArrowLeft className="size-3.5" /> {label}
    </button>
  );
}

/** Forgotten password: always the same confirmation (no account discovery). */
function ForgotStep({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/forgot", { email });
      setSent(true);
    } catch (err) {
      setError(errorText(t, err, t("common.error")));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="space-y-5">
        <StepHeader icon={MailCheck} title={t("forgot.sentTitle")} text={t("forgot.sentText", { email })} />
        <BackLink onClick={onBack} label={t("forgot.back")} />
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <StepHeader icon={KeyRound} title={t("forgot.title")} text={t("forgot.text")} />
      <Label htmlFor="forgot-email" className="sr-only">{t("login.email")}</Label>
      <div className="relative">
        <Mail className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#9a9ca4]" />
        <Input
          id="forgot-email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={FIELD}
          placeholder={t("login.email")}
        />
      </div>
      <FormError message={error} />
      <div className="space-y-4 pt-1">
        <GoldButton busy={busy}>{t("forgot.submit")}</GoldButton>
        <BackLink onClick={onBack} label={t("forgot.back")} />
      </div>
    </form>
  );
}

/** Choose a password from an emailed link (forgotten password or welcome). */
function ResetStep({ token, onDone, onNewLink }: { token: string; onDone: (notice?: string) => void; onNewLink: () => void }) {
  const { t } = useTranslation();
  const [check, setCheck] = useState<{ valid: boolean; purpose?: "reset" | "welcome" } | null>(null);
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .post<{ valid: boolean; purpose?: "reset" | "welcome" }>("/auth/reset/check", { token })
      .then(setCheck)
      .catch(() => setCheck({ valid: false }));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError(t("password.mismatch"));
    if (next.length < 12) return setError(t("password.short"));
    setBusy(true);
    try {
      await api.post("/auth/reset", { token, password: next });
      onDone(t("reset.done"));
    } catch (err) {
      setError(errorText(t, err, t("common.error")));
      setBusy(false);
    }
  }

  if (!check) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="size-6 animate-spin text-[#ffce1a]" />
      </div>
    );
  }
  if (!check.valid) {
    return (
      <div className="space-y-5">
        <StepHeader icon={KeyRound} title={t("reset.invalidTitle")} text={t("reset.invalid")} />
        <GoldButton onClick={onNewLink}>{t("reset.newLink")}</GoldButton>
        <BackLink onClick={() => onDone()} label={t("forgot.back")} />
      </div>
    );
  }
  const welcome = check.purpose === "welcome";
  return (
    <form onSubmit={submit} className="space-y-4">
      <StepHeader icon={Lock} title={welcome ? t("reset.welcomeTitle") : t("reset.title")} text={welcome ? t("reset.welcomeText") : t("reset.text")} />
      <div className="space-y-1.5">
        <Label htmlFor="reset-new">{t("password.next")}</Label>
        <Input id="reset-new" type="password" autoComplete="new-password" required autoFocus value={next} onChange={(e) => setNext(e.target.value)} className="h-11" />
        <p className="text-xs text-muted-foreground">{t("password.rule")}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="reset-confirm">{t("password.confirm")}</Label>
        <Input id="reset-confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-11" />
      </div>
      <FormError message={error} />
      <GoldButton busy={busy}>{t("reset.submit")}</GoldButton>
    </form>
  );
}

/** Dark glass input with a gold focus glow. */
const FIELD =
  "h-12 rounded-xl border-white/10 bg-white/[0.04] pl-10 text-[15px] text-[#ededf0] placeholder:text-[#6b6d75] transition-shadow focus-visible:border-[#ffce1a]/60 focus-visible:ring-[#ffce1a]/25 focus-visible:shadow-[0_0_24px_-6px_rgba(255,206,26,0.45)]";

function GoldButton({ busy, children, onClick }: { busy?: boolean; children: React.ReactNode; onClick?: () => void }) {
  return (
    <Button
      type={onClick ? "button" : "submit"}
      onClick={onClick}
      disabled={busy}
      className="group h-12 w-full rounded-xl bg-grad-gold font-semibold text-[#1a1204] glow-gold transition-transform hover:brightness-105 active:scale-[0.99]"
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
      className="mt-6 block w-full text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
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
      {email && <p className="-mt-3 text-center font-mono text-xs text-muted-foreground">{email}</p>}
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
      {email && <p className="-mt-3 text-center font-mono text-xs text-muted-foreground">{email}</p>}
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
