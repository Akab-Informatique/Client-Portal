import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarDays, Eye, EyeOff, Inbox, Loader2, Plus, Send, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAdminError } from "./hooks";

type Link = { id: string; source: "user" | "app"; ownerId: string | null; mailbox: string | null; calendarName: string | null; label: string; display: "details" | "busy"; push: boolean; signedIn: boolean };
type View = {
  enabled: boolean;
  mailbox: string | null;
  integrationReady: boolean;
  signIn: { email: string; needsReconnect: boolean } | null;
  links: Link[];
  people: { id: string; name: string; email: string; signedIn: boolean }[];
};
type Calendar = { id: string; name: string; isDefault: boolean; canEdit: boolean };

/**
 * Master admins: Microsoft 365 for one technician — sync on / off, and the
 * calendars shown in their planning, each in detail or as busy times only.
 */
export function O365Panel({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errText = useAdminError();
  const confirm = useConfirm();
  const key = ["admin", "users", userId, "o365"];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<View>(`/admin/users/${userId}/o365`) });
  const [adding, setAdding] = useState(false);
  const done = (next: View) => {
    qc.setQueryData(key, next);
    void qc.invalidateQueries({ queryKey: ["planning"] });
  };
  const sync = useMutation({
    mutationFn: (enabled: boolean) => api.put<View>(`/admin/users/${userId}/o365`, { enabled }),
    onSuccess: (n) => {
      done(n);
      toast.success(t("common.saved"));
    },
    onError: (e) => toast.error(errText(e)),
  });
  const patch = useMutation({
    mutationFn: (p: { id: string; display?: "details" | "busy"; push?: boolean }) => api.patch<View>(`/admin/calendar-links/${p.id}`, { display: p.display, push: p.push }),
    onSuccess: done,
    onError: (e) => toast.error(errText(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del<View>(`/admin/calendar-links/${id}`),
    onSuccess: done,
    onError: (e) => toast.error(errText(e)),
  });
  if (!data) return null;
  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <label className="flex items-center justify-between gap-4">
        <span>
          <span className="flex items-center gap-2 font-medium">
            <CalendarDays className="size-4 text-primary" /> {t("admin.o365.title")}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{data.integrationReady ? t("admin.o365.hint") : t("admin.users.o365NotReady")}</span>
        </span>
        <Switch checked={data.enabled} disabled={sync.isPending} onCheckedChange={(v) => sync.mutate(v)} />
      </label>
      <p className={cn("flex items-center gap-2 text-xs", data.signIn ? "text-emerald-300" : "text-muted-foreground")}>
        <UserRound className="size-3.5" />
        {data.signIn ? t("admin.o365.signedIn", { email: data.signIn.email }) : t("admin.o365.notSignedIn")}
      </p>

      {data.enabled && (
        <>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("admin.o365.shown")}</p>
          {data.links.length === 0 ? (
            <p className="rounded-lg border border-dashed p-2.5 text-xs text-muted-foreground">{t("admin.o365.defaultOwn")}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {data.links.map((l) => (
                <li key={l.id} className="space-y-2 p-2.5">
                  <div className="flex items-center gap-2">
                    {l.source === "user" ? <UserRound className="size-3.5 shrink-0 text-primary" /> : <Inbox className="size-3.5 shrink-0 text-sky-300" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{l.label}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {[l.mailbox ?? t("admin.o365.waitingSignIn"), l.calendarName, t(`admin.o365.source.${l.source}`)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7 text-muted-foreground hover:text-destructive"
                      title={t("admin.o365.remove")}
                      onClick={() => void confirm({ title: t("admin.o365.removeConfirm", { name: l.label }), destructive: true }).then((ok) => ok && remove.mutate(l.id))}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <DisplayToggle value={l.display} onChange={(display) => patch.mutate({ id: l.id, display })} />
                    <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Send className="size-3" /> {t("admin.o365.push")}
                      <Switch checked={l.push} onCheckedChange={(push) => patch.mutate({ id: l.id, push })} />
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {adding ? (
            <AddLink userId={userId} view={data} onDone={(n) => (done(n), setAdding(false))} onCancel={() => setAdding(false)} />
          ) : (
            <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setAdding(true)} disabled={!data.integrationReady}>
              <Plus className="size-3.5" /> {t("admin.o365.add")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function DisplayToggle({ value, onChange }: { value: "details" | "busy"; onChange: (v: "details" | "busy") => void }) {
  const { t } = useTranslation();
  return (
    <div className="inline-flex rounded-lg border p-0.5 text-[11px]">
      {(["details", "busy"] as const).map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          className={cn("flex items-center gap-1 rounded-md px-2 py-1 font-medium", value === k ? "bg-grad-gold text-[#1a1204]" : "text-muted-foreground hover:text-foreground")}
          title={t(`admin.o365.displayHint.${k}`)}
        >
          {k === "details" ? <Eye className="size-3" /> : <EyeOff className="size-3" />} {t(`admin.o365.display.${k}`)}
        </button>
      ))}
    </div>
  );
}

/** Add a calendar: someone's own sign-in, or any mailbox through the organisation access. */
function AddLink({ userId, view, onDone, onCancel }: { userId: string; view: View; onDone: (v: View) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const errText = useAdminError();
  const [source, setSource] = useState<"user" | "app">("user");
  const [ownerId, setOwnerId] = useState<string>(view.people.find((p) => p.id === userId && p.signedIn)?.id ?? "");
  const [mailbox, setMailbox] = useState("");
  const [calendar, setCalendar] = useState<string>("");
  const [display, setDisplay] = useState<"details" | "busy">("details");
  const [push, setPush] = useState(view.links.length === 0);
  const ready = source === "user" ? Boolean(ownerId) : /.+@.+\..+/.test(mailbox.trim());
  const cals = useQuery({
    queryKey: ["admin", "o365", "calendars", source, ownerId, mailbox.trim().toLowerCase()],
    queryFn: () => api.get<Calendar[]>(`/admin/users/${userId}/o365/calendars?${new URLSearchParams(source === "user" ? { source, ownerId } : { source, mailbox: mailbox.trim() })}`),
    enabled: ready,
    retry: false,
    staleTime: 60_000,
  });
  const chosen = cals.data?.find((c) => c.id === calendar);
  const add = useMutation({
    mutationFn: () =>
      api.post<View>(`/admin/users/${userId}/calendar-links`, {
        source,
        ...(source === "user" ? { ownerId } : { mailbox: mailbox.trim() }),
        ...(chosen && !chosen.isDefault ? { calendarId: chosen.id, calendarName: chosen.name } : {}),
        display,
        push,
      }),
    onSuccess: onDone,
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <div className="space-y-3 rounded-lg border border-[color:var(--gold)]/40 p-3">
      <div className="grid grid-cols-2 gap-1 rounded-lg border p-0.5 text-[11px]">
        {(["user", "app"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => (setSource(k), setCalendar(""))}
            className={cn("rounded-md px-2 py-1.5 font-medium", source === k ? "bg-grad-gold text-[#1a1204]" : "text-muted-foreground hover:text-foreground")}
          >
            {t(`admin.o365.source.${k}`)}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">{t(`admin.o365.sourceHint.${source}`)}</p>
      {source === "user" ? (
        <Select value={ownerId} onValueChange={(v) => (setOwnerId(v), setCalendar(""))}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={t("admin.o365.pickPerson")} />
          </SelectTrigger>
          <SelectContent>
            {view.people.map((p) => (
              <SelectItem key={p.id} value={p.id} disabled={!p.signedIn}>
                {p.name} {p.signedIn ? "" : `— ${t("admin.o365.notSignedInShort")}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input type="email" value={mailbox} onChange={(e) => (setMailbox(e.target.value), setCalendar(""))} placeholder={t("admin.o365.mailbox")} className="h-8 text-xs" />
      )}
      {ready && (
        <div className="space-y-1">
          {cals.isLoading ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : cals.isError ? (
            <p className="text-xs text-destructive">{errText(cals.error)}</p>
          ) : (
            <Select value={calendar || cals.data?.find((c) => c.isDefault)?.id || ""} onValueChange={setCalendar}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={t("admin.o365.pickCalendar")} />
              </SelectTrigger>
              <SelectContent>
                {(cals.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} {c.isDefault ? `· ${t("admin.o365.main")}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <DisplayToggle value={display} onChange={setDisplay} />
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Send className="size-3" /> {t("admin.o365.push")}
          <Switch checked={push} onCheckedChange={setPush} />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" size="sm" className="h-8 bg-grad-gold font-semibold text-[#1a1204]" disabled={!ready || add.isPending || cals.isError} onClick={() => add.mutate()}>
          {add.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("admin.o365.addIt")}
        </Button>
      </div>
    </div>
  );
}
