import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, Pencil, Plus, Search, Send, Trash2, UserPlus, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { contactsKey, type MailContact } from "./RecipientInput";

/** The technician's address book: everyone they wrote to, plus the ones added by hand. */
export function ContactsView({ canSend, onWrite }: { canSend: boolean; onWrite: (address: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setQ(text.trim()), 200);
    return () => clearTimeout(h);
  }, [text]);
  const list = useQuery({
    queryKey: contactsKey(`all:${q}`),
    queryFn: () => api.get<MailContact[]>(`/outlook/contacts?limit=1000&q=${encodeURIComponent(q)}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["outlook", "contacts"] });
  const onError = (e: unknown) => toast.error(e instanceof ApiError && e.status === 400 ? t("outlook.contacts.invalid") : t("common.error"));

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ address: "", name: "" });
  const add = useMutation({
    mutationFn: () => api.post("/outlook/contacts", { address: draft.address.trim(), name: draft.name.trim() || undefined }),
    onSuccess: () => {
      setDraft({ address: "", name: "" });
      setAdding(false);
      void refresh();
    },
    onError,
  });
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const rename = useMutation({
    mutationFn: (e: { id: string; name: string }) => api.patch(`/outlook/contacts/${e.id}`, { name: e.name.trim() || null }),
    onSuccess: () => {
      setEditing(null);
      void refresh();
    },
    onError,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/outlook/contacts/${id}`), onSuccess: refresh, onError });
  const when = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { dateStyle: "medium" }).format(new Date(iso)) : "—";
  const rows = list.data ?? [];

  return (
    <div className="glass flex h-[calc(100dvh-11.5rem)] min-h-[520px] flex-col overflow-hidden rounded-2xl border">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <h2 className="flex items-center gap-2 font-semibold">
          <Users className="size-5 text-primary" /> {t("outlook.contacts.title")}
          {list.data && <span className="text-sm font-normal text-muted-foreground">({rows.length})</span>}
        </h2>
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("outlook.contacts.search")} />
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)}>
          <UserPlus className="size-4" /> {t("outlook.contacts.add")}
        </Button>
      </div>
      <p className="border-b px-3 py-2 text-xs text-muted-foreground">{t("outlook.contacts.hint")}</p>
      {adding && (
        <form
          className="flex flex-wrap items-center gap-2 border-b p-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (draft.address.trim()) add.mutate();
          }}
        >
          <Input
            autoFocus
            type="email"
            required
            className="max-w-xs"
            placeholder={t("outlook.contacts.address")}
            value={draft.address}
            onChange={(e) => setDraft({ ...draft, address: e.target.value })}
          />
          <Input
            className="max-w-xs"
            placeholder={t("outlook.contacts.name")}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <Button type="submit" size="sm" disabled={add.isPending || !draft.address.trim()}>
            {add.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {t("common.save")}
          </Button>
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {list.isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{q ? t("outlook.contacts.noMatch") : t("outlook.contacts.empty")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card/95 text-left text-xs uppercase tracking-wide text-muted-foreground backdrop-blur">
              <tr>
                <th className="px-3 py-2 font-medium">{t("outlook.contacts.name")}</th>
                <th className="px-3 py-2 font-medium">{t("outlook.contacts.address")}</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">{t("outlook.contacts.used")}</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">{t("outlook.contacts.last")}</th>
                <th className="w-0 px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((c) => (
                <tr key={c.id} className="group hover:bg-accent/30">
                  <td className="px-3 py-2">
                    {editing?.id === c.id ? (
                      <form
                        className="flex items-center gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          rename.mutate(editing);
                        }}
                      >
                        <Input autoFocus className="h-8" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                        <button type="submit" className="p-1 text-emerald-400" aria-label={t("common.save")}>
                          <Check className="size-4" />
                        </button>
                        <button type="button" className="p-1 text-muted-foreground" aria-label={t("common.cancel")} onClick={() => setEditing(null)}>
                          <X className="size-4" />
                        </button>
                      </form>
                    ) : (
                      <span className={c.name ? "font-medium" : "text-muted-foreground"}>{c.name || "—"}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">{c.address}</td>
                  <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">
                    {c.source === "manual" && !c.timesUsed ? t("outlook.contacts.manual") : t("outlook.contacts.times", { count: c.timesUsed })}
                  </td>
                  <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">{when(c.lastUsedAt)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      {canSend && (
                        <Button size="sm" variant="ghost" className="h-8" onClick={() => onWrite(c.address)} title={t("outlook.contacts.write")}>
                          <Send className="size-4" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8"
                        onClick={() => setEditing({ id: c.id, name: c.name ?? "" })}
                        title={t("outlook.contacts.rename")}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 text-muted-foreground hover:text-red-400"
                        title={t("common.delete")}
                        onClick={() =>
                          void confirm({ title: t("outlook.contacts.deleteConfirm", { address: c.address }), destructive: true }).then(
                            (ok) => ok && remove.mutate(c.id),
                          )
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
