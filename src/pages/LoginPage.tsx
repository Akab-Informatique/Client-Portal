import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import {
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  Moon,
  ShieldCheck,
  Smartphone,
  Sun,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BorderBeam } from "@/components/ui/border-beam";
import { BlurFade } from "@/components/ui/blur-fade";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/hooks/use-theme";
import { useLocale } from "@/hooks/use-locale";
import { LOCALES } from "@/i18n";
import { cn } from "@/lib/utils";
import { BrandLogo } from "@/components/BrandLogo";
import { AkabLoader } from "@/components/AkabLoader";

type Step = "password" | "challenge" | "enroll" | "recovery_codes";
type ChallengeMode = "totp" | "email" | "recovery";

export function LoginPage() {
  const {
    user,
    loading,
    login,
    mfaPending,
    clearMfaPending,
    verifyMfaTotp,
    verifyMfaRecovery,
    sendMfaEmailCode,
    verifyMfaEmailCode,
    startMfaEnroll,
    confirmMfaEnroll,
  } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { t, locale, setLocale } = useLocale();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [step, setStep] = useState<Step>("password");
  const [challengeMode, setChallengeMode] = useState<ChallengeMode>("totp");
  const [mfaCode, setMfaCode] = useState("");
  const [enroll, setEnroll] = useState<{
    secret: string;
    qrUrl: string;
  } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  // Resume MFA if page reload mid-flow
  useEffect(() => {
    if (loading || user) return;
    if (!mfaPending) {
      setStep("password");
      return;
    }
    if (mfaPending.kind === "challenge") {
      setStep("challenge");
      setChallengeMode("totp");
    } else {
      setStep("enroll");
      void (async () => {
        const started = await startMfaEnroll();
        if ("secret" in started) {
          setEnroll({ secret: started.secret, qrUrl: started.qrUrl });
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, mfaPending?.kind, mfaPending?.email, user]);

  if (loading) {
    return <AkabLoader fullScreen size="xl" label={t("app.loading")} />;
  }

  if (user?.mfa_enabled) {
    return (
      <Navigate
        to={user.role === "client" ? "/client" : "/admin"}
        replace
      />
    );
  }

  const mapMfaError = (code: string | undefined, message?: string) => {
    switch (code) {
      case "invalid_code":
        return t("mfa.invalidCode");
      case "expired":
        return t("mfa.codeExpired");
      case "smtp":
        return message || t("mfa.emailSendFailed");
      case "no_pending":
        return t("mfa.sessionExpired");
      default:
        return message || t("mfa.genericError");
    }
  };

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setSubmitting(true);
    const result = await login(email, password);
    setSubmitting(false);
    if (!result.ok) {
      setError(
        result.error === "deactivated"
          ? t("login.deactivated")
          : t("login.invalid"),
      );
      return;
    }
    setPassword("");
    setMfaCode("");
    if (result.needsMfa && result.kind === "challenge") {
      setStep("challenge");
      setChallengeMode("totp");
      return;
    }
    // Forced enrollment
    setStep("enroll");
    setSubmitting(true);
    const started = await startMfaEnroll();
    setSubmitting(false);
    if ("secret" in started) {
      setEnroll({ secret: started.secret, qrUrl: started.qrUrl });
    } else {
      setError(t("mfa.genericError"));
      setStep("password");
    }
  };

  const handleChallengeSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setSubmitting(true);
    let result;
    if (challengeMode === "totp") {
      result = await verifyMfaTotp(mfaCode);
    } else if (challengeMode === "email") {
      result = await verifyMfaEmailCode(mfaCode);
    } else {
      result = await verifyMfaRecovery(mfaCode);
    }
    setSubmitting(false);
    if (!result.ok) {
      setError(mapMfaError(result.error, result.message));
      return;
    }
    navigate("/");
  };

  const handleSendEmail = async () => {
    setError(null);
    setInfo(null);
    setSubmitting(true);
    const result = await sendMfaEmailCode();
    setSubmitting(false);
    if (!result.ok) {
      setError(mapMfaError(result.error, result.message));
      return;
    }
    setChallengeMode("email");
    setMfaCode("");
    setInfo(t("mfa.emailSent"));
  };

  const handleEnrollConfirm = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await confirmMfaEnroll(mfaCode);
    setSubmitting(false);
    if (!result.ok) {
      setError(mapMfaError(result.error));
      return;
    }
    setRecoveryCodes(result.recoveryCodes);
    setStep("recovery_codes");
  };

  const handleFinishRecovery = () => {
    setRecoveryCodes(null);
    navigate("/");
  };

  const copyRecovery = async () => {
    if (!recoveryCodes?.length) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const backToPassword = () => {
    clearMfaPending();
    setStep("password");
    setMfaCode("");
    setEnroll(null);
    setError(null);
    setInfo(null);
    setChallengeMode("totp");
  };

  const title =
    step === "challenge"
      ? t("mfa.challengeTitle")
      : step === "enroll"
        ? t("mfa.enrollTitle")
        : step === "recovery_codes"
          ? t("mfa.recoveryTitle")
          : t("login.cardTitle");

  const desc =
    step === "challenge"
      ? t("mfa.challengeDesc")
      : step === "enroll"
        ? t("mfa.enrollDesc")
        : step === "recovery_codes"
          ? t("mfa.recoveryDesc")
          : t("login.cardDesc");

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div
        aria-hidden
        className="absolute inset-0 bg-black bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url(/login-bg.png)" }}
      />
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/35 to-black/60"
      />

      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <div
          className="flex items-center rounded-lg border border-white/15 bg-black/40 p-0.5 backdrop-blur-md"
          role="group"
          aria-label={t("common.language")}
        >
          {LOCALES.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => setLocale(l.code)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-semibold transition-colors",
                locale === l.code
                  ? "bg-primary text-primary-foreground"
                  : "text-white/70 hover:text-white",
              )}
            >
              {l.code.toUpperCase()}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={toggleTheme}
          aria-label={t("common.theme")}
          className="border-white/15 bg-black/40 text-white backdrop-blur-md hover:bg-black/55 hover:text-white"
        >
          {theme === "dark" ? (
            <Sun className="size-4" />
          ) : (
            <Moon className="size-4" />
          )}
        </Button>
      </div>

      <BlurFade delay={0.05} className="relative z-10 w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex justify-center drop-shadow-lg">
            <BrandLogo size="xl" imgClassName="h-16 sm:h-20" />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-white drop-shadow-sm sm:text-3xl">
            {t("login.title")}
          </h1>
          <p className="mt-1 text-sm text-white/75">{t("login.subtitle")}</p>
        </div>

        <Card className="relative overflow-hidden border-white/10 bg-card/95 shadow-2xl backdrop-blur-md">
          <BorderBeam
            size={120}
            duration={8}
            colorFrom="#F5C518"
            colorTo="#111111"
          />
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-xl">
              {(step === "challenge" || step === "enroll") && (
                <ShieldCheck className="size-5 text-primary" />
              )}
              {title}
            </CardTitle>
            <CardDescription>{desc}</CardDescription>
            {mfaPending?.email && step !== "password" && (
              <p className="pt-1 text-xs text-muted-foreground">
                {mfaPending.email}
              </p>
            )}
          </CardHeader>
          <CardContent>
            {step === "password" && (
              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">{t("login.email")}</Label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      autoComplete="username"
                      className="pl-9"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">{t("login.password")}</Label>
                  <div className="relative">
                    <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      className="pl-9 pr-10"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                    <button
                      type="button"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={
                        showPassword
                          ? t("login.hidePassword")
                          : t("login.showPassword")
                      }
                    >
                      {showPassword ? (
                        <EyeOff className="size-4" />
                      ) : (
                        <Eye className="size-4" />
                      )}
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full"
                  disabled={submitting || loading}
                >
                  {submitting ? t("login.submitting") : t("login.submit")}
                </Button>
              </form>
            )}

            {step === "challenge" && (
              <form onSubmit={handleChallengeSubmit} className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={challengeMode === "totp" ? "default" : "outline"}
                    className="gap-1.5"
                    onClick={() => {
                      setChallengeMode("totp");
                      setMfaCode("");
                      setError(null);
                      setInfo(null);
                    }}
                  >
                    <Smartphone className="size-3.5" />
                    {t("mfa.methodApp")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={challengeMode === "email" ? "default" : "outline"}
                    className="gap-1.5"
                    disabled={submitting}
                    onClick={() => void handleSendEmail()}
                  >
                    <Mail className="size-3.5" />
                    {t("mfa.methodEmail")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      challengeMode === "recovery" ? "default" : "outline"
                    }
                    className="gap-1.5"
                    onClick={() => {
                      setChallengeMode("recovery");
                      setMfaCode("");
                      setError(null);
                      setInfo(null);
                    }}
                  >
                    <KeyRound className="size-3.5" />
                    {t("mfa.methodRecovery")}
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mfaCode">
                    {challengeMode === "recovery"
                      ? t("mfa.recoveryCodeLabel")
                      : t("mfa.codeLabel")}
                  </Label>
                  <Input
                    id="mfaCode"
                    inputMode={challengeMode === "recovery" ? "text" : "numeric"}
                    autoComplete="one-time-code"
                    autoFocus
                    placeholder={
                      challengeMode === "recovery" ? "XXXXX-XXXXX" : "000000"
                    }
                    className="font-mono tracking-widest"
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    {challengeMode === "totp"
                      ? t("mfa.totpHint")
                      : challengeMode === "email"
                        ? t("mfa.emailHint")
                        : t("mfa.recoveryHint")}
                  </p>
                </div>

                {info && (
                  <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground">
                    {info}
                  </div>
                )}
                {error && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full"
                  disabled={submitting || !mfaCode.trim()}
                >
                  {submitting ? t("mfa.verifying") : t("mfa.verify")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={backToPassword}
                >
                  {t("mfa.backToSignIn")}
                </Button>
              </form>
            )}

            {step === "enroll" && (
              <form onSubmit={handleEnrollConfirm} className="space-y-4">
                <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                  {t("mfa.enrollRequiredNote")}
                </div>

                {enroll ? (
                  <div className="flex flex-col items-center gap-3">
                    <img
                      src={enroll.qrUrl}
                      alt={t("mfa.qrAlt")}
                      width={200}
                      height={200}
                      className="rounded-lg border border-border bg-white p-2"
                    />
                    <div className="w-full space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        {t("mfa.manualSecret")}
                      </p>
                      <code className="block break-all rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs">
                        {enroll.secret}
                      </code>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-center py-6">
                    <AkabLoader size="md" label={t("common.loading")} />
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="enrollCode">{t("mfa.confirmCodeLabel")}</Label>
                  <Input
                    id="enrollCode"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    className="font-mono tracking-widest"
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    required
                  />
                </div>

                {error && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full"
                  disabled={submitting || !enroll || !mfaCode.trim()}
                >
                  {submitting ? t("mfa.verifying") : t("mfa.enableMfa")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={backToPassword}
                >
                  {t("mfa.backToSignIn")}
                </Button>
              </form>
            )}

            {step === "recovery_codes" && recoveryCodes && (
              <div className="space-y-4">
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                  {t("mfa.recoverySaveWarning")}
                </div>
                <ul className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/30 p-3 font-mono text-sm">
                  {recoveryCodes.map((c) => (
                    <li key={c} className="text-center">
                      {c}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1 gap-2"
                    onClick={() => void copyRecovery()}
                  >
                    {copied ? (
                      <Check className="size-4" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                    {copied ? t("mfa.copied") : t("mfa.copyCodes")}
                  </Button>
                  <Button
                    type="button"
                    className="flex-1"
                    onClick={handleFinishRecovery}
                  >
                    {t("mfa.continueToPortal")}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </BlurFade>
    </div>
  );
}
