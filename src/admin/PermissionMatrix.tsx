import { useTranslation } from "react-i18next";
import { Check, Minus, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { MODULES, type Audience, type Localized } from "@shared/permissions";
import { cn } from "@/lib/utils";

function useL() {
  const { i18n } = useTranslation();
  return (l: Localized) => (i18n.language === "en" ? l.en : l.fr);
}

/** Checkbox grid of rights grouped by module — used to build roles. */
export function PermissionMatrix({
  audience,
  value,
  onChange,
  disabled,
}: {
  audience: Audience;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const L = useL();
  const modules = MODULES.filter((m) => m.audience === audience);
  const toggle = (key: string, on: boolean) => onChange(on ? [...new Set([...value, key])] : value.filter((k) => k !== key));
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {modules.map((m) => {
        const keys = m.permissions.map((p) => p.key as string);
        const count = keys.filter((k) => value.includes(k)).length;
        const all = count === keys.length;
        return (
          <div key={m.key} className={cn("rounded-xl border bg-background/40", count > 0 && "border-[color:var(--gold)]/30")}>
            <label className="flex items-center gap-3 border-b px-3 py-2.5">
              <Checkbox
                disabled={disabled}
                checked={all ? true : count > 0 ? "indeterminate" : false}
                onCheckedChange={(v) => onChange(v ? [...new Set([...value, ...keys])] : value.filter((k) => !keys.includes(k)))}
              />
              <span className="flex-1 font-display text-sm font-semibold">{L(m.label)}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {count}/{keys.length}
              </span>
            </label>
            <ul className="space-y-0.5 p-1.5">
              {m.permissions.map((p) => (
                <li key={p.key}>
                  <label className={cn("flex items-start gap-3 rounded-lg px-2 py-1.5", !disabled && "cursor-pointer hover:bg-accent/50")}>
                    <Checkbox className="mt-0.5" disabled={disabled} checked={value.includes(p.key)} onCheckedChange={(v) => toggle(p.key, Boolean(v))} />
                    <span>
                      <span className="block text-sm">{L(p.label)}</span>
                      {"description" in p && p.description && <span className="block text-xs text-muted-foreground">{L(p.description)}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export type OverrideMap = Record<string, "allow" | "deny" | undefined>;

/**
 * Per-user rights on top of the role: each right is Role (inherit),
 * Grant (allow) or Remove (deny); the effective result is shown live.
 */
export function OverridesEditor({
  audience,
  rolePermissions,
  value,
  onChange,
  disabled,
}: {
  audience: Audience;
  rolePermissions: string[];
  value: OverrideMap;
  onChange: (v: OverrideMap) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const L = useL();
  const modules = MODULES.filter((m) => m.audience === audience);
  return (
    <div className="space-y-3">
      {modules.map((m) => (
        <div key={m.key} className="rounded-xl border">
          <div className="border-b px-3 py-2 font-display text-sm font-semibold">{L(m.label)}</div>
          <ul className="divide-y">
            {m.permissions.map((p) => {
              const fromRole = rolePermissions.includes(p.key);
              const ov = value[p.key];
              const effective = ov === "allow" ? true : ov === "deny" ? false : fromRole;
              const opts = [
                { v: undefined, label: t("admin.access.inherit"), icon: Minus },
                { v: "allow" as const, label: t("admin.access.allow"), icon: Check },
                { v: "deny" as const, label: t("admin.access.deny"), icon: X },
              ];
              return (
                <li key={p.key} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <span className={cn("flex size-6 items-center justify-center rounded-md", effective ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
                    {effective ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{L(p.label)}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {t("admin.access.fromRole")}: {fromRole ? t("admin.access.granted") : t("admin.access.notGranted")}
                    </span>
                  </span>
                  <div className="flex rounded-lg border p-0.5">
                    {opts.map((o) => (
                      <button
                        key={o.label}
                        type="button"
                        disabled={disabled}
                        onClick={() => onChange({ ...value, [p.key]: o.v })}
                        className={cn(
                          "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-50",
                          ov === o.v
                            ? o.v === "allow"
                              ? "bg-success/15 text-success"
                              : o.v === "deny"
                                ? "bg-destructive/15 text-destructive"
                                : "bg-accent text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <o.icon className="size-3" /> {o.label}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
