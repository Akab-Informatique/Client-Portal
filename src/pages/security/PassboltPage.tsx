import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy, Eye, EyeOff, KeyRound, Loader2, Lock, LockOpen, Search, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { KeyHolder, PassboltError, listResources, login, readSecret, unlockKey, type ResourceView, type Transport } from "@/lib/passbolt/client";

type Status = { enabled: boolean; baseUrl: string; hasKey: boolean; fingerprint: string | null; passboltUserId: string | null };

/** Calls to Passbolt go through the portal's forwarding (same origin); nothing else leaves the browser. */
const transport: Transport = async (method, path, opts = {}) => {
  const res = await fetch(`/api/passbolt/proxy${path}${opts.query ? `?${opts.query}` : ""}`, {
    method,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

/** The key and the token live here, in memory only: closing the tab, or the idle time, forgets them. */
const listeners = new Set<() => void>();
const holder = new KeyHolder(5 * 60_000, () => {
  session.token = null;
  listeners.forEach((l) => l());
});
const session: { token: string | null } = { token: null };

/**
 * Sécurité › Passbolt (a spike, with test data only). Passbolt is the vault; this is the screen. The person's key
 * (protected by their passphrase) is kept by the portal, the passphrase is typed here and never sent, and
 * what they may see is decrypted in this browser.
 */
export function PassboltPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: s, isLoading } = useQuery({ queryKey: ["passbolt", "status"], queryFn: () => api.get<Status>("/passbolt/status") });
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const unlocked = holder.unlocked && Boolean(session.token);
  const errText = (e: unknown) =>
    e instanceof PassboltError
      ? t(`passbolt.errors.${e.code}`, { defaultValue: e.detail ?? t("common.error") })
      : e instanceof ApiError
        ? t(`passbolt.errors.${e.code}`, { defaultValue: t("common.error") })
        : t("common.error");
  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <KeyRound className="size-6 text-primary" /> {t("passbolt.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("passbolt.subtitle")}</p>
      </div>
      <p className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-100">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" /> {t("passbolt.spike")}
      </p>
      {isLoading || !s ? (
        <Loader2 className="mx-auto my-10 size-5 animate-spin text-muted-foreground" />
      ) : !s.enabled ? (
        <p className="glass rounded-2xl border border-dashed py-12 text-center text-sm text-muted-foreground">{t("passbolt.notConnected")}</p>
      ) : !s.hasKey ? (
        <KeyCard onSaved={() => void qc.invalidateQueries({ queryKey: ["passbolt", "status"] })} errText={errText} />
      ) : !unlocked ? (
        <UnlockCard s={s} errText={errText} onChanged={() => void qc.invalidateQueries({ queryKey: ["passbolt", "status"] })} onUnlocked={() => force((n) => n + 1)} />
      ) : (
        <Vault baseUrl={s.baseUrl} errText={errText} />
      )}
    </div>
  );
}

/** Put the key (still protected by its passphrase) in the profile of the portal. */
function KeyCard({ onSaved, errText }: { onSaved: () => void; errText: (e: unknown) => string }) {
  const { t } = useTranslation();
  const [armored, setArmored] = useState("");
  const [userId, setUserId] = useState("");
  const save = useMutation({
    mutationFn: () => api.put("/passbolt/key", { armoredKey: armored.trim(), passboltUserId: userId.trim() }),
    onSuccess: () => {
      setArmored("");
      toast.success(t("passbolt.keySaved"));
      onSaved();
    },
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <section className="glass space-y-3 rounded-2xl border p-5">
      <h2 className="text-sm font-semibold">{t("passbolt.keyTitle")}</h2>
      <p className="text-xs text-muted-foreground">{t("passbolt.keyHint")}</p>
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">{t("passbolt.userId")}</span>
          <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" className="font-mono text-xs" required />
        </label>
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">{t("passbolt.privateKey")}</span>
          <Textarea value={armored} onChange={(e) => setArmored(e.target.value)} rows={8} spellCheck={false} placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----" className="font-mono text-[11px]" required />
        </label>
        <Button type="submit" disabled={save.isPending || !armored.trim() || !userId.trim()} className="bg-grad-gold font-semibold text-[#1a1204]">
          {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("passbolt.saveKey")}
        </Button>
      </form>
    </section>
  );
}

/** The passphrase, typed here only: it unlocks the key in memory and signs in to Passbolt. */
function UnlockCard({ s, errText, onChanged, onUnlocked }: { s: Status; errText: (e: unknown) => string; onChanged: () => void; onUnlocked: () => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [pass, setPass] = useState("");
  const unlock = useMutation({
    mutationFn: async () => {
      const k = await api.get<{ armoredKey: string; passboltUserId: string }>("/passbolt/key");
      const key = await unlockKey(k.armoredKey, pass);
      const tok = await login(transport, key, k.passboltUserId, s.baseUrl);
      holder.set(key);
      session.token = tok.accessToken;
    },
    onSuccess: () => {
      setPass("");
      onUnlocked();
    },
    onError: (e) => toast.error(errText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.del("/passbolt/key"),
    onSuccess: onChanged,
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <section className="glass max-w-md space-y-3 rounded-2xl border p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Lock className="size-4 text-primary" /> {t("passbolt.locked")}
      </h2>
      <p className="text-xs text-muted-foreground">{t("passbolt.unlockHint")}</p>
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (pass) unlock.mutate();
        }}
      >
        <Input type="password" autoComplete="off" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} placeholder={t("passbolt.passphrase")} aria-label={t("passbolt.passphrase")} />
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={unlock.isPending || !pass} className="bg-grad-gold font-semibold text-[#1a1204]">
            {unlock.isPending ? <Loader2 className="size-4 animate-spin" /> : <LockOpen className="size-4" />} {t("passbolt.unlock")}
          </Button>
          <span className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => void confirm({ title: t("passbolt.removeKeyTitle"), description: t("passbolt.removeKeyText"), confirmLabel: t("passbolt.removeKey"), destructive: true }).then((ok) => ok && remove.mutate())}
          >
            <Trash2 className="size-3.5" /> {t("passbolt.removeKey")}
          </Button>
        </div>
        {s.fingerprint && <p className="font-mono text-[10px] text-muted-foreground">{s.fingerprint.match(/.{1,4}/g)?.join(" ")}</p>}
      </form>
    </section>
  );
}

/** The list of what they can reach; a click reveals one secret here (decrypted in this browser) for 30 seconds. */
function Vault({ baseUrl, errText }: { baseUrl: string; errText: (e: unknown) => string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["passbolt", "list", baseUrl],
    queryFn: () => listResources(transport, session.token!, holder.get()),
    retry: false,
    staleTime: 60_000,
  });
  useEffect(() => {
    if (error) toast.error(errText(error));
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (data ?? []).filter((r) => words.every((w) => `${r.name} ${r.username} ${r.uri}`.toLowerCase().includes(w)));
  }, [data, q]);
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("passbolt.search")} className="pl-9" />
        </div>
        <span className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => holder.lock()}>
          <Lock className="size-3.5" /> {t("passbolt.lock")}
        </Button>
      </div>
      {isLoading && <Loader2 className="mx-auto my-8 size-5 animate-spin text-muted-foreground" />}
      {!isLoading && list.length === 0 && <p className="glass rounded-2xl border border-dashed py-10 text-center text-sm text-muted-foreground">{t("passbolt.none")}</p>}
      {list.length > 0 && (
        <ul className="glass divide-y divide-border/60 overflow-hidden rounded-2xl border">
          {list.map((r) => (
            <Row key={r.id} r={r} errText={errText} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({ r, errText }: { r: ResourceView; errText: (e: unknown) => string }) {
  const { t } = useTranslation();
  const [secret, setSecret] = useState<{ password: string; description: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = () => {
    setSecret(null);
    if (timer.current) clearTimeout(timer.current);
  };
  useEffect(() => hide, []);
  const reveal = useMutation({
    mutationFn: async () => {
      const s = await readSecret(transport, session.token!, holder.get(), r.id);
      // the event only, never the secret or the name
      void api.post("/passbolt/reveal-log", { resourceId: r.id }).catch(() => undefined);
      return s;
    },
    onSuccess: (s) => {
      setSecret(s);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(hide, 30_000);
    },
    onError: (e) => toast.error(errText(e)),
  });
  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("common.error"));
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{r.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{[r.username, r.uri].filter(Boolean).join(" · ")}</span>
      </span>
      {secret ? (
        <span className="flex items-center gap-2">
          <code className="max-w-64 select-all truncate rounded bg-muted px-2 py-1 font-mono text-xs">{secret.password}</code>
          <Button size="icon" variant="outline" className="size-8" onClick={() => void copy()} aria-label={t("passbolt.copy")}>
            {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
          </Button>
          <Button size="icon" variant="ghost" className="size-8" onClick={hide} aria-label={t("passbolt.hide")}>
            <EyeOff className="size-4" />
          </Button>
        </span>
      ) : (
        <Button size="sm" variant="outline" disabled={reveal.isPending} onClick={() => reveal.mutate()} className={cn("gap-1.5")}>
          {reveal.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Eye className="size-3.5" />} {t("passbolt.reveal")}
        </Button>
      )}
      {secret?.description && <span className="w-full whitespace-pre-wrap text-xs text-muted-foreground">{secret.description}</span>}
    </li>
  );
}
