import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Eye, EyeOff, Lock, Mail, Moon, Sun } from "lucide-react";
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

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { t, locale, setLocale } = useLocale();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return <AkabLoader fullScreen size="xl" label={t("app.loading")} />;
  }

  if (user) {
    return (
      <Navigate
        to={user.role === "client" ? "/client" : "/admin"}
        replace
      />
    );
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
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
    navigate("/");
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      {/* Full-bleed brand background */}
      <div
        aria-hidden
        className="absolute inset-0 bg-black bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url(/login-bg.png)" }}
      />
      {/* Soft vignette so the form stays readable on any crop */}
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
            <CardTitle className="text-xl">{t("login.cardTitle")}</CardTitle>
            <CardDescription>{t("login.cardDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
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
          </CardContent>
        </Card>
      </BlurFade>
    </div>
  );
}
