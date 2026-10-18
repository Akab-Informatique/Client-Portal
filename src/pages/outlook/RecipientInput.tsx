import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export type MailContact = {
  id: string;
  address: string;
  name: string | null;
  note: string | null;
  source: "manual" | "sent";
  timesUsed: number;
  lastUsedAt: string | null;
};
export const contactsKey = (q: string) => ["outlook", "contacts", q] as const;

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
/** "Name <a@b.c>", "a@b.c" → the address */
const addressOf = (s: string) => (s.match(/<([^>]+)>/)?.[1] ?? s).trim().replace(/^mailto:/i, "");

/** Addresses as chips; suggestions from the technician's address book. */
export function RecipientInput({
  value,
  onChange,
  autoFocus,
  label,
  id,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  autoFocus?: boolean;
  label: string;
  id?: string;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = setTimeout(() => setQ(text.trim()), 120);
    return () => clearTimeout(h);
  }, [text]);
  const found = useQuery({
    queryKey: contactsKey(q),
    queryFn: () => api.get<MailContact[]>(`/outlook/contacts?limit=8&q=${encodeURIComponent(q)}`),
    enabled: open && q.length >= 1,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const suggestions = (found.data ?? []).filter((c) => !value.includes(c.address)).slice(0, 8);

  /** Typed or pasted text → chips (separated by , ; space or new lines) */
  const commit = (raw: string) => {
    const parts = raw
      .split(/[,;\n\s]+/)
      .map(addressOf)
      .filter(Boolean);
    if (!parts.length) return;
    onChange([...value, ...parts.filter((p) => !value.some((v) => v.toLowerCase() === p.toLowerCase()))]);
    setText("");
  };
  const pick = (c: MailContact) => {
    if (!value.includes(c.address)) onChange([...value, c.address]);
    setText("");
    setActive(0);
    input.current?.focus();
  };

  return (
    <div className="relative">
      <div
        className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border bg-background/60 px-1.5 py-1 focus-within:border-[color:var(--gold)]/60"
        onClick={() => input.current?.focus()}
      >
        {value.map((a) => {
          const ok = EMAIL.test(a);
          return (
            <span
              key={a}
              className={cn(
                "flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                ok ? "border-[color:var(--gold)]/30 bg-[color:var(--gold)]/10" : "border-destructive/60 bg-destructive/15 text-destructive",
              )}
              title={ok ? a : t("outlook.errors.invalid_address", { address: a })}
            >
              <span className="truncate">{a}</span>
              <button
                type="button"
                aria-label={t("common.delete")}
                onClick={() => onChange(value.filter((x) => x !== a))}
                className="opacity-70 hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        <input
          ref={input}
          id={id}
          aria-label={label}
          autoFocus={autoFocus}
          value={text}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // a click on a suggestion comes first
            setTimeout(() => setOpen(false), 150);
            commit(text);
          }}
          onPaste={(e) => {
            const p = e.clipboardData.getData("text");
            if (/[,;\n]/.test(p)) {
              e.preventDefault();
              commit(text + p);
            }
          }}
          onKeyDown={(e) => {
            if (open && suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab" || e.key === "," || e.key === ";") {
              if (open && suggestions.length && text.trim() && !EMAIL.test(text.trim())) {
                e.preventDefault();
                pick(suggestions[active] ?? suggestions[0]);
                return;
              }
              if (text.trim()) {
                if (e.key !== "Tab") e.preventDefault();
                commit(text);
              } else if (e.key === "Enter") e.preventDefault();
            }
            if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
            if (e.key === "Escape") setOpen(false);
          }}
          className="min-w-[10rem] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none"
        />
      </div>
      {open && text.trim() && suggestions.length > 0 && (
        <ul className="absolute inset-x-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-lg border bg-popover p-1 shadow-xl">
          {suggestions.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(c)}
                className={cn("flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm", i === active ? "bg-accent" : "hover:bg-accent/60")}
              >
                <span className="truncate font-medium">{c.name || c.address}</span>
                {c.name && <span className="truncate text-xs text-muted-foreground">{c.address}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const isAddress = (a: string) => EMAIL.test(a);
