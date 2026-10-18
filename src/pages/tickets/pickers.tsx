import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building, Building2, Check, ChevronDown, Loader2, Mail, Phone, Search, UserPlus, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ticketErrorText } from "./shared";

/**
 * Client and contact pickers (Autotask Companies / Contacts). Searchable, and
 * the contact picker can create a new contact for the chosen client.
 */
export type Company = { id: number; name: string };
export type Contact = { id: string; companyId: number; name: string; email: string | null; phone: string | null };

export type Contract = { id: string; name: string; isDefault: boolean; endDate: string | null };

/** All clients (Autotask can have thousands): loaded once and kept 10 minutes. */
export function useCompanies() {
  return useQuery({ queryKey: ["tickets", "companies"], queryFn: () => api.get<Company[]>("/tickets/companies"), staleTime: 10 * 60_000 });
}

export function useContracts(companyId: number | null) {
  return useQuery({
    queryKey: ["tickets", "contracts", companyId],
    queryFn: () => api.get<Contract[]>(`/tickets/companies/${companyId}/contracts`),
    enabled: Boolean(companyId),
    staleTime: 10 * 60_000,
  });
}

export function useContacts(companyId: number | null) {
  return useQuery({
    queryKey: ["tickets", "contacts", companyId],
    queryFn: () => api.get<Contact[]>(`/tickets/companies/${companyId}/contacts`),
    enabled: Boolean(companyId),
    staleTime: 5 * 60_000,
  });
}

function PickerShell({
  trigger,
  open,
  onOpenChange,
  disabled,
  children,
  triggerClassName,
  ariaLabel,
}: {
  trigger: ReactNode;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
  triggerClassName?: string;
  ariaLabel: string;
}) {
  if (disabled) return <span className={triggerClassName}>{trigger}</span>;
  return (
    // modal: the picker owns the focus while open (it is often inside a dialog that traps focus)
    <Popover modal open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            "group flex w-full min-w-0 items-center justify-between gap-2 rounded-md text-left outline-none ring-[color:var(--gold)]/40 transition hover:ring-2 focus-visible:ring-2 data-[state=open]:ring-2",
            triggerClassName,
          )}
        >
          <span className="min-w-0 flex-1 truncate">{trigger}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1.5">
        {children}
      </PopoverContent>
    </Popover>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative mb-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-8 pl-8" />
    </div>
  );
}

export function CompanyPicker({
  value,
  companies,
  onChange,
  disabled,
  triggerClassName,
  placeholder,
  canCreate,
}: {
  value: Company | null;
  companies: Company[];
  onChange: (c: Company) => void;
  disabled?: boolean;
  triggerClassName?: string;
  placeholder?: string;
  /** Offer "New client" (Autotask company) at the bottom */
  canCreate?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const shown = companies.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <PickerShell
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setQ("");
          setCreating(false);
        }
      }}
      disabled={disabled}
      triggerClassName={triggerClassName}
      ariaLabel={t("tickets.fields.company")}
      trigger={value ? value.name : <span className="text-muted-foreground">{placeholder ?? t("tickets.pickCompany")}</span>}
    >
      {creating ? (
        <NewCompanyForm
          initialName={q}
          onCancel={() => setCreating(false)}
          onCreated={(c) => {
            onChange(c);
            setCreating(false);
            setOpen(false);
          }}
        />
      ) : (
      <>
      <SearchBox value={q} onChange={setQ} placeholder={t("tickets.searchCompany")} />
      <div className="max-h-64 overflow-y-auto">
        {shown.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => {
              onChange(c);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
          >
            <Building2 className="size-4 text-muted-foreground" />
            <span className="flex-1 truncate">{c.name}</span>
            {value?.id === c.id && <Check className="size-4 text-primary" />}
          </button>
        ))}
        {shown.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground">{t("tickets.noMatch")}</p>}
      </div>
      {canCreate && (
        <div className="mt-1 border-t pt-1">
          <Button type="button" variant="ghost" size="sm" className="h-8 w-full text-xs text-primary" onClick={() => setCreating(true)}>
            <Building className="size-3.5" /> {t("tickets.newCompany")}
          </Button>
        </div>
      )}
      </>
      )}
    </PickerShell>
  );
}

function NewCompanyForm({ initialName, onCancel, onCreated }: { initialName: string; onCancel: () => void; onCreated: (c: Company) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: initialName.trim(), phone: "" });
  const create = useMutation({
    mutationFn: () => api.post<Company>("/tickets/companies", f),
    onSuccess: (c) => {
      // the new client in the list right away (Autotask's list is cached)
      qc.setQueryData<Company[]>(["tickets", "companies"], (old) => [...(old ?? []), c].sort((x, y) => x.name.localeCompare(y.name)));
      void qc.invalidateQueries({ queryKey: ["tickets", "companies"] });
      toast.success(t("tickets.companyCreated", { name: c.name }));
      onCreated(c);
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "Validation failed" ? t("tickets.companyInvalid") : ticketErrorText(t, e)),
  });
  return (
    <form
      className="space-y-2 p-1"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        e.stopPropagation();
        create.mutate();
      }}
    >
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Building className="size-4 text-primary" /> {t("tickets.newCompany")}
      </p>
      <Input autoFocus required minLength={2} maxLength={100} placeholder={t("tickets.companyName")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="h-8" />
      <div className="relative">
        <Phone className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input required minLength={7} maxLength={40} type="tel" placeholder={t("tickets.companyPhone")} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} className="h-8 pl-8" />
      </div>
      <p className="text-[11px] text-muted-foreground">{t("tickets.companySync")}</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={create.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
          {create.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("common.create")}
        </Button>
      </div>
    </form>
  );
}

export function ContactPicker({
  companyId,
  value,
  valueName,
  onChange,
  disabled,
  triggerClassName,
  canCreate,
}: {
  companyId: number | null;
  value: string | null;
  valueName?: string;
  onChange: (c: Contact | null) => void;
  disabled?: boolean;
  triggerClassName?: string;
  canCreate: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const { data: contacts = [], isLoading } = useContacts(companyId);
  const current = contacts.find((c) => c.id === value);
  const shown = contacts.filter((c) => !q || `${c.name} ${c.email ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const label = current?.name ?? valueName;
  return (
    <PickerShell
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setQ("");
          setCreating(false);
        }
      }}
      disabled={disabled || !companyId}
      triggerClassName={triggerClassName}
      ariaLabel={t("tickets.fields.contact")}
      trigger={label ? label : <span className="text-muted-foreground">{companyId ? t("tickets.pickContact") : t("tickets.pickCompanyFirst")}</span>}
    >
      {creating && companyId ? (
        <NewContactForm
          companyId={companyId}
          onCancel={() => setCreating(false)}
          onCreated={(c) => {
            onChange(c);
            setCreating(false);
            setOpen(false);
          }}
        />
      ) : (
        <>
          <SearchBox value={q} onChange={setQ} placeholder={t("tickets.searchContact")} />
          <div className="max-h-64 overflow-y-auto">
            {isLoading && <Loader2 className="mx-auto my-3 size-4 animate-spin text-muted-foreground" />}
            {shown.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                <UserRound className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{c.name}</span>
                  {(c.email || c.phone) && <span className="block truncate text-[11px] text-muted-foreground">{[c.email, c.phone].filter(Boolean).join(" · ")}</span>}
                </span>
                {value === c.id && <Check className="size-4 text-primary" />}
              </button>
            ))}
            {!isLoading && shown.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground">{t("tickets.noMatch")}</p>}
          </div>
          <div className="mt-1 flex gap-1 border-t pt-1">
            {value && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 flex-1 text-xs text-muted-foreground"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                {t("tickets.noContact")}
              </Button>
            )}
            {canCreate && (
              <Button type="button" variant="ghost" size="sm" className="h-8 flex-1 text-xs text-primary" onClick={() => setCreating(true)}>
                <UserPlus className="size-3.5" /> {t("tickets.newContact")}
              </Button>
            )}
          </div>
        </>
      )}
    </PickerShell>
  );
}

function NewContactForm({ companyId, onCancel, onCreated }: { companyId: number; onCancel: () => void; onCreated: (c: Contact) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", phone: "" });
  const create = useMutation({
    mutationFn: () => api.post<Contact>(`/tickets/companies/${companyId}/contacts`, f),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ["tickets", "contacts", companyId] });
      toast.success(t("tickets.contactCreated", { name: c.name }));
      onCreated(c);
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "Validation failed" ? t("tickets.contactInvalid") : ticketErrorText(t, e)),
  });
  return (
    <form
      className="space-y-2 p-1"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        e.stopPropagation();
        create.mutate();
      }}
    >
      <p className="flex items-center gap-2 text-sm font-semibold">
        <UserPlus className="size-4 text-primary" /> {t("tickets.newContact")}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Input autoFocus required placeholder={t("tickets.contactFirstName")} value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} className="h-8" />
        <Input required placeholder={t("tickets.contactLastName")} value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} className="h-8" />
      </div>
      <div className="relative">
        <Mail className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input type="email" placeholder={t("common.email")} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className="h-8 pl-8" />
      </div>
      <div className="relative">
        <Phone className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder={t("common.phone")} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} className="h-8 pl-8" />
      </div>
      <p className="text-[11px] text-muted-foreground">{t("tickets.contactSync")}</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={create.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
          {create.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("common.create")}
        </Button>
      </div>
    </form>
  );
}
