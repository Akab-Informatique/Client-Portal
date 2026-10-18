import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Minus, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { ACCESS_LAYOUT, MODULES, type Audience, type Localized } from "@shared/permissions";
import { cn } from "@/lib/utils";

function useL() {
  const { i18n } = useTranslation();
  return (l: Localized) => (i18n.language === "en" ? l.en : l.fr);
}

type Module = (typeof MODULES)[number];

/** The sidebar's sections and their pages, for one audience. */
function sectionsFor(audience: Audience) {
  return ACCESS_LAYOUT.filter((s) => s.audience === audience).map((s) => ({
    ...s,
    pages: s.modules.map((k) => MODULES.find((m) => m.key === k)).filter((m): m is Module => Boolean(m)),
  }));
}
const keysOf = (pages: Module[]) => pages.flatMap((m) => m.permissions.map((p) => p.key as string));

/**
 * Rights of a role, laid out like the sidebar: a whole section at once, a
 * page at once, or right by right.
 */
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
  const { t } = useTranslation();
  const L = useL();
  const sections = sectionsFor(audience);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const set = (keys: string[], on: boolean) => onChange(on ? [...new Set([...value, ...keys])] : value.filter((k) => !keys.includes(k)));
  const state = (keys: string[]) => {
    const n = keys.filter((k) => value.includes(k)).length;
    return { n, all: n === keys.length && n > 0, checked: n === keys.length && n > 0 ? true : n > 0 ? ("indeterminate" as const) : false };
  };
  return (
    <div className="space-y-3">
      {sections.map((s) => {
        const keys = keysOf(s.pages);
        const st = state(keys);
        const open = !closed.has(s.key);
        return (
          <section key={s.key} className={cn("rounded-2xl border", st.n > 0 ? "border-[color:var(--gold)]/30 bg-[color:var(--gold)]/[0.03]" : "bg-background/30")}>
            <div className="flex items-center gap-3 px-3 py-2.5">
              <Checkbox disabled={disabled} checked={st.checked} onCheckedChange={(v) => set(keys, Boolean(v))} aria-label={t("admin.access.wholeSection", { name: L(s.label) })} />
              <button
                type="button"
                onClick={() => setClosed((c) => (c.has(s.key) ? new Set([...c].filter((x) => x !== s.key)) : new Set([...c, s.key])))}
                className="flex flex-1 items-center gap-2 text-left"
                aria-expanded={open}
              >
                <span className="font-display text-sm font-bold uppercase tracking-[0.08em]">{L(s.label)}</span>
                <span className="text-[11px] text-muted-foreground">{s.pages.map((p) => L(p.label)).join(" · ")}</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                  {st.n}/{keys.length}
                </span>
                <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", !open && "-rotate-90")} />
              </button>
            </div>
            {open && (
              <div className="grid gap-2 border-t p-2 sm:grid-cols-2">
                {s.pages.map((m) => {
                  const pk = m.permissions.map((p) => p.key as string);
                  const ps = state(pk);
                  return (
                    <div key={m.key} className={cn("rounded-xl border bg-background/40", ps.n > 0 && "border-[color:var(--gold)]/30")}>
                      <label className="flex items-center gap-3 border-b px-3 py-2">
                        <Checkbox disabled={disabled} checked={ps.checked} onCheckedChange={(v) => set(pk, Boolean(v))} />
                        <span className="flex-1 text-sm font-semibold">{L(m.label)}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {ps.n}/{pk.length}
                        </span>
                      </label>
                      <ul className="space-y-0.5 p-1.5">
                        {m.permissions.map((p) => (
                          <li key={p.key}>
                            <label className={cn("flex items-start gap-3 rounded-lg px-2 py-1.5", !disabled && "cursor-pointer hover:bg-accent/50")}>
                              <Checkbox className="mt-0.5" disabled={disabled} checked={value.includes(p.key)} onCheckedChange={(v) => set([p.key], Boolean(v))} />
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
            )}
          </section>
        );
      })}
    </div>
  );
}

export type OverrideMap = Record<string, "allow" | "deny" | undefined>;

/**
 * Per-user rights on top of the role: each right is Role (inherit),
 * Grant (allow) or Remove (deny); the effective result is shown live.
 * Grouped like the sidebar; a whole section can be set at once.
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
  const opts = [
    { v: undefined, label: t("admin.access.inherit"), icon: Minus },
    { v: "allow" as const, label: t("admin.access.allow"), icon: Check },
    { v: "deny" as const, label: t("admin.access.deny"), icon: X },
  ];
  const choice = (current: "allow" | "deny" | undefined | "mixed", onPick: (v: "allow" | "deny" | undefined) => void, small?: boolean) => (
    <div className="flex rounded-lg border p-0.5">
      {opts.map((o) => (
        <button
          key={o.label}
          type="button"
          disabled={disabled}
          onClick={() => onPick(o.v)}
          className={cn(
            "flex items-center gap-1 rounded-md px-2 py-1 transition-colors disabled:opacity-50",
            small ? "text-[11px]" : "text-xs",
            current === o.v
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
  );
  const setAll = (keys: string[], v: "allow" | "deny" | undefined) => onChange({ ...value, ...Object.fromEntries(keys.map((k) => [k, v])) });
  const common = (keys: string[]) => {
    const vs = new Set(keys.map((k) => value[k]));
    return vs.size === 1 ? [...vs][0] : ("mixed" as const);
  };
  return (
    <div className="space-y-4">
      {sectionsFor(audience).map((s) => {
        const keys = keysOf(s.pages);
        return (
          <section key={s.key} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-1 font-display text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">{L(s.label)}</span>
              {choice(common(keys), (v) => setAll(keys, v), true)}
            </div>
            {s.pages.map((m) => (
              <div key={m.key} className="rounded-xl border">
                <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
                  <span className="flex-1 font-display text-sm font-semibold">{L(m.label)}</span>
                  {m.permissions.length > 1 &&
                    choice(
                      common(m.permissions.map((p) => p.key)),
                      (v) => setAll(m.permissions.map((p) => p.key), v),
                      true,
                    )}
                </div>
                <ul className="divide-y">
                  {m.permissions.map((p) => {
                    const fromRole = rolePermissions.includes(p.key);
                    const ov = value[p.key];
                    const effective = ov === "allow" ? true : ov === "deny" ? false : fromRole;
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
                        {choice(ov, (v) => onChange({ ...value, [p.key]: v }))}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
