import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  LayoutDashboard,
  LayoutGrid,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Star,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";
import type { DashboardWidget } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ConfirmDialog";

export type Visibility = "private" | "team" | "admins";
export type Access = "view" | "edit";
export type DashboardInfo = {
  id: string;
  slug: string | null;
  name: string;
  visibility: Visibility;
  teamAccess: Access;
  /** What I see: my own layout if I personalized it, else the default */
  layout: DashboardWidget[];
  defaultLayout: DashboardWidget[];
  personalLayout: boolean;
  ownerName: string | null;
  mine: boolean;
  isDefault: boolean;
  /** Change the default layout (for everyone) */
  canEdit: boolean;
  /** Save my own layout */
  canCustomize: boolean;
  canAdminister: boolean;
  canDelete: boolean;
  visibilityOptions: Visibility[];
  members: { userId: string; name: string | null; access: Access }[];
};
type Person = { id: string; name: string; email: string };

export function useDashboards() {
  return useQuery({ queryKey: ["dashboards"], queryFn: () => api.get<DashboardInfo[]>("/dashboards") });
}

const VIS_ICON: Record<Visibility, typeof Lock> = { private: Lock, team: Users, admins: ShieldCheck };

export function useDashboardName() {
  const { t } = useTranslation();
  return (d: Pick<DashboardInfo, "slug" | "name">) => (d.slug ? t(`dashboards.builtin.${d.slug}`, { defaultValue: d.name }) : d.name);
}

/** Dashboard name with a drop-down to switch to another one or create one. */
export function DashboardPicker({ current, onSelect }: { current: DashboardInfo | null; onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  const name = useDashboardName();
  const { data: list = [] } = useDashboards();
  const [creating, setCreating] = useState(false);
  const shared = list.filter((d) => d.visibility !== "private" || !d.mine);
  const priv = list.filter((d) => d.visibility === "private" && d.mine);

  const Row = ({ d }: { d: DashboardInfo }) => {
    const Icon = VIS_ICON[d.visibility];
    return (
      <DropdownMenuItem onSelect={() => onSelect(d.id)} className="gap-3">
        <Icon className="size-4" />
        <span className="flex-1 truncate">{name(d)}</span>
        {d.isDefault && <Star className="size-3.5 fill-current text-[color:var(--gold)]" aria-label={t("dashboards.isDefault")} />}
        {current?.id === d.id && <Check className="size-4 text-primary" />}
      </DropdownMenuItem>
    );
  };

  return (
    <>
      <DropdownMenu>
        <h1 className="text-2xl font-bold">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="group -ml-2 flex items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-accent/60 data-[state=open]:bg-accent/60"
            >
              {current ? name(current) : t("nav.dashboard")}
              <ChevronDown className="size-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </button>
          </DropdownMenuTrigger>
        </h1>
        <DropdownMenuContent align="start" className="w-72">
          {shared.length > 0 && (
            <>
              <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("dashboards.shared")}</DropdownMenuLabel>
              {shared.map((d) => (
                <Row key={d.id} d={d} />
              ))}
            </>
          )}
          {priv.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("dashboards.private")}</DropdownMenuLabel>
              {priv.map((d) => (
                <Row key={d.id} d={d} />
              ))}
            </>
          )}
          {list.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={() => setCreating(true)} className="gap-3 text-primary focus:text-primary">
            <Plus className="size-4" /> {t("dashboards.new")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NameDialog state={creating ? { mode: "create" } : null} onClose={() => setCreating(false)} onCreated={onSelect} />
    </>
  );
}

/** "Personnaliser" menu: widgets, default dashboard, and (when allowed) rename, access, delete. */
export function DashboardMenu({ d, onEditWidgets, onDeleted }: { d: DashboardInfo; onEditWidgets: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [access, setAccess] = useState(false);

  const setDefault = useMutation({
    mutationFn: () => api.put("/dashboards/default", { id: d.id }),
    onSuccess: () => {
      toast.success(t("dashboards.defaultSet"));
      void qc.invalidateQueries({ queryKey: ["dashboards"] });
    },
    onError: () => toast.error(t("common.error")),
  });
  const backToDefault = useMutation({
    mutationFn: () => api.del(`/dashboards/${d.id}/my-layout`),
    onSuccess: () => {
      toast.success(t("dashboards.backToDefaultDone"));
      void qc.invalidateQueries({ queryKey: ["dashboards"] });
    },
    onError: () => toast.error(t("common.error")),
  });
  const teamCustomize = useMutation({
    mutationFn: (on: boolean) => api.patch(`/dashboards/${d.id}`, { teamAccess: on ? "edit" : "view" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["dashboards"] }),
    onError: () => toast.error(t("common.error")),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/dashboards/${d.id}`),
    onSuccess: () => {
      onDeleted();
      void qc.invalidateQueries({ queryKey: ["dashboards"] });
    },
    onError: () => toast.error(t("common.error")),
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="data-[state=open]:border-[color:var(--gold)]/50">
            <LayoutGrid className="size-4" /> {t("dashboard.customize")}
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {(d.canEdit || d.canCustomize) && (
            <DropdownMenuItem onSelect={onEditWidgets}>
              <LayoutGrid className="size-4" /> {t("dashboards.editWidgets")}
            </DropdownMenuItem>
          )}
          {d.personalLayout && (
            <DropdownMenuItem onSelect={() => void confirm({ title: t("dashboards.backToDefaultConfirm") }).then((ok) => ok && backToDefault.mutate())}>
              <RotateCcw className="size-4" /> {t("dashboards.backToDefault")}
            </DropdownMenuItem>
          )}
          {d.isDefault ? (
            <DropdownMenuItem disabled>
              <Star className="size-4 fill-current text-[color:var(--gold)]" /> {t("dashboards.isDefault")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => setDefault.mutate()}>
              <Star className="size-4" /> {t("dashboards.makeDefault")}
            </DropdownMenuItem>
          )}
          {(d.canAdminister || d.canDelete) && <DropdownMenuSeparator />}
          {d.canAdminister && d.visibility === "team" && (
            <DropdownMenuCheckboxItem
              checked={d.teamAccess === "edit"}
              onCheckedChange={(on) => teamCustomize.mutate(Boolean(on))}
              onSelect={(e) => e.preventDefault()}
            >
              {t("dashboards.teamCustomize")}
            </DropdownMenuCheckboxItem>
          )}
          {d.canAdminister && !d.slug && (
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <Pencil className="size-4" /> {t("dashboards.rename")}
            </DropdownMenuItem>
          )}
          {d.canAdminister && (
            <DropdownMenuItem onSelect={() => setAccess(true)}>
              <ShieldCheck className="size-4" /> {t("dashboards.access")}
            </DropdownMenuItem>
          )}
          {d.canDelete && (
            <DropdownMenuItem variant="destructive" onSelect={() => void confirm({ title: t("dashboards.deleteConfirm"), destructive: true }).then((ok) => ok && remove.mutate())}>
              <Trash2 className="size-4" /> {t("common.delete")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <NameDialog state={renaming ? { mode: "rename", d } : null} onClose={() => setRenaming(false)} onCreated={() => undefined} />
      <AccessDialog d={d} open={access} onClose={() => setAccess(false)} />
    </>
  );
}

type NameState = { mode: "create" } | { mode: "rename"; d: DashboardInfo } | null;

function NameDialog({ state, onClose, onCreated }: { state: NameState; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "team">("private");
  const open = Boolean(state);
  const initialName = state?.mode === "rename" ? state.d.name : "";
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setVisibility("private");
  }, [open, initialName]);

  const save = useMutation({
    mutationFn: () =>
      state?.mode === "rename"
        ? api.patch<DashboardInfo>(`/dashboards/${state.d.id}`, { name })
        : api.post<DashboardInfo>("/dashboards", { name, visibility }),
    onSuccess: (d) => {
      // Put it in the list right away so selecting it does not bounce back to the default
      qc.setQueryData<DashboardInfo[]>(["dashboards"], (old) => [...(old ?? []).filter((x) => x.id !== d.id), d]);
      void qc.invalidateQueries({ queryKey: ["dashboards"] });
      if (state?.mode === "create") onCreated(d.id);
      onClose();
    },
    onError: () => toast.error(t("common.error")),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutDashboard className="size-5 text-primary" />
            {state?.mode === "rename" ? t("dashboards.rename") : t("dashboards.new")}
          </DialogTitle>
          {state?.mode === "create" && <DialogDescription>{t("dashboards.newText")}</DialogDescription>}
        </DialogHeader>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
          className="space-y-5"
        >
          <div className="space-y-2">
            <Label htmlFor="dash-name">{t("dashboards.name")}</Label>
            <Input id="dash-name" required maxLength={120} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("dashboards.namePlaceholder")} />
          </div>
          {state?.mode === "create" && (
            <ChoiceCards
              value={visibility}
              onChange={setVisibility}
              options={(["private", "team"] as const).map((v) => ({ value: v, icon: VIS_ICON[v], title: t(`dashboards.visShort.${v}`), text: t(`dashboards.vis.${v}`) }))}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {state?.mode === "rename" ? t("common.save") : t("common.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChoiceCards<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; icon: typeof Lock; title: string; text: string }[];
}) {
  return (
    <div className={cn("grid gap-2", options.length > 1 && "grid-cols-2")}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors",
            value === o.value ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10" : "hover:bg-accent/50",
          )}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <o.icon className="size-4 text-primary" /> {o.title}
          </span>
          <span className="text-xs text-muted-foreground">{o.text}</span>
        </button>
      ))}
    </div>
  );
}

/** Who sees the dashboard, what they may do, and access for specific people. */
function AccessDialog({ d, open, onClose }: { d: DashboardInfo; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const name = useDashboardName();
  const [visibility, setVisibility] = useState<Visibility>(d.visibility);
  const [teamAccess, setTeamAccess] = useState<Access>(d.teamAccess);
  const [members, setMembers] = useState(d.members);
  useEffect(() => {
    if (!open) return;
    setVisibility(d.visibility);
    setTeamAccess(d.teamAccess);
    setMembers(d.members);
    // only when the dialog opens: refetches must not wipe pending edits
  }, [open]);

  const { data: people = [] } = useQuery({
    queryKey: ["dashboards", "people"],
    queryFn: () => api.get<Person[]>("/dashboards/people"),
    enabled: open,
  });
  const candidates = useMemo(
    () => people.filter((p) => p.id !== me.id && !members.some((m) => m.userId === p.id)),
    [people, members, me.id],
  );

  const save = useMutation({
    mutationFn: async () => {
      const patch: Record<string, string> = {};
      if (visibility !== d.visibility) patch.visibility = visibility;
      if (teamAccess !== d.teamAccess) patch.teamAccess = teamAccess;
      if (Object.keys(patch).length) await api.patch(`/dashboards/${d.id}`, patch);
      const same =
        members.length === d.members.length && members.every((m) => d.members.some((x) => x.userId === m.userId && x.access === m.access));
      if (!same) await api.put(`/dashboards/${d.id}/members`, { members: members.map(({ userId, access }) => ({ userId, access })) });
    },
    onSuccess: () => {
      toast.success(t("common.saved"));
      void qc.invalidateQueries({ queryKey: ["dashboards"] });
      onClose();
    },
    onError: () => toast.error(t("common.error")),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" /> {t("dashboards.access")} · {name(d)}
          </DialogTitle>
          <DialogDescription>{t("dashboards.accessIntro")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t("dashboards.whoSees")}</h3>
            {d.visibilityOptions.length > 0 ? (
              <ChoiceCards
                value={visibility}
                onChange={setVisibility}
                options={d.visibilityOptions.map((v) => ({ value: v, icon: VIS_ICON[v], title: t(`dashboards.visShort.${v}`), text: t(`dashboards.vis.${v}`) }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t(`dashboards.vis.${d.visibility}`)}</p>
            )}
          </section>

          {/* Administrators always change the default (dashboard.manage), so the switch only matters for the team */}
          {visibility === "team" && (
            <label className="flex items-start justify-between gap-4 rounded-xl border p-3">
              <span>
                <span className="block text-sm font-semibold">{t("dashboards.teamCustomize")}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t("dashboards.teamCustomizeText")}</span>
              </span>
              <Switch checked={teamAccess === "edit"} onCheckedChange={(on) => setTeamAccess(on ? "edit" : "view")} />
            </label>
          )}

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t("dashboards.people")}</h3>
            <p className="text-xs text-muted-foreground">{t("dashboards.peopleText")}</p>
            <ul className="divide-y rounded-xl border">
              {members.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">{t("dashboards.noPeople")}</li>}
              {members.map((m) => (
                <li key={m.userId} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{m.name ?? people.find((p) => p.id === m.userId)?.name}</span>
                  <Select
                    value={m.access}
                    onValueChange={(v) => setMembers((ms) => ms.map((x) => (x.userId === m.userId ? { ...x, access: v as Access } : x)))}
                  >
                    <SelectTrigger size="sm" className="w-48" aria-label={t("dashboards.accessFor", { name: m.name ?? "" })}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="view">{t("dashboards.accessLevel.view")}</SelectItem>
                      <SelectItem value="edit">{t("dashboards.accessLevel.edit")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    aria-label={t("dashboards.removePerson")}
                    onClick={() => setMembers((ms) => ms.filter((x) => x.userId !== m.userId))}
                  >
                    <X className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
            {candidates.length > 0 && (
              <Select
                value=""
                onValueChange={(id) => {
                  const p = people.find((x) => x.id === id);
                  if (p) setMembers((ms) => [...ms, { userId: p.id, name: p.name, access: "view" }]);
                }}
              >
                <SelectTrigger size="sm" className="w-full" aria-label={t("dashboards.addPerson")}>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <UserPlus className="size-4" /> {t("dashboards.addPerson")}
                  </span>
                </SelectTrigger>
                <SelectContent position="popper" className="max-h-64">
                  {candidates.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} <span className="text-xs text-muted-foreground">{p.email}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </section>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
