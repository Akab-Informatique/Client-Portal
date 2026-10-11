import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronDown, Eye, LayoutDashboard, Loader2, Lock, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2, UserRound, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import type { DashboardWidget } from "@/lib/types";
import { cn } from "@/lib/utils";

export type Visibility = "private" | "team" | "admins";
export type DashboardInfo = {
  id: string;
  slug: string | null;
  name: string;
  visibility: Visibility;
  layout: DashboardWidget[];
  ownerName: string | null;
  mine: boolean;
  canEdit: boolean;
  canDelete: boolean;
  visibilityOptions: Visibility[];
};

export function useDashboards() {
  return useQuery({ queryKey: ["dashboards"], queryFn: () => api.get<DashboardInfo[]>("/dashboards") });
}

const KEY = "akab.dashboard.current";
/** Last dashboard viewed ("me" = personal), remembered in this browser. */
export function useCurrentDashboard(): [string, (id: string) => void] {
  const [current, setState] = useState<string>(() => {
    try {
      return localStorage.getItem(KEY) || "me";
    } catch {
      return "me";
    }
  });
  const set = useCallback((id: string) => {
    setState(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* ignore */
    }
  }, []);
  return [current, set];
}

const VIS_ICON: Record<Visibility, typeof Lock> = { private: Lock, team: Users, admins: ShieldCheck };

function useName() {
  const { t } = useTranslation();
  return (d: Pick<DashboardInfo, "slug" | "name">) => (d.slug ? t(`dashboards.builtin.${d.slug}`) : d.name);
}

export function DashboardPicker({ current, onSelect }: { current: string; onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const name = useName();
  const { data: list = [] } = useDashboards();
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "rename"; d: DashboardInfo } | null>(null);
  const selected = list.find((d) => d.id === current) ?? null;
  const shared = list.filter((d) => d.visibility !== "private");
  const priv = list.filter((d) => d.visibility === "private");

  const update = useMutation({
    mutationFn: (p: { id: string; visibility: Visibility }) => api.patch(`/dashboards/${p.id}`, { visibility: p.visibility }),
    onSuccess: () => {
      toast.success(t("common.saved"));
      void qc.invalidateQueries({ queryKey: ["dashboards"] });
    },
    onError: () => toast.error(t("common.error")),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/dashboards/${id}`),
    onSuccess: () => {
      onSelect("me");
      void qc.invalidateQueries({ queryKey: ["dashboards"] });
    },
    onError: () => toast.error(t("common.error")),
  });

  const Row = ({ d }: { d: DashboardInfo }) => {
    const Icon = VIS_ICON[d.visibility];
    return (
      <DropdownMenuItem onSelect={() => onSelect(d.id)} className="gap-3">
        <Icon className="size-4" />
        <span className="flex-1 truncate">{name(d)}</span>
        {!d.mine && d.ownerName && <span className="max-w-24 truncate text-[11px] text-muted-foreground">{d.ownerName}</span>}
        {current === d.id && <Check className="size-4 text-primary" />}
      </DropdownMenuItem>
    );
  };

  return (
    <div className="flex items-center gap-1.5">
      <DropdownMenu>
        <h1 className="text-2xl font-bold">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="group -ml-2 flex items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-accent/60 data-[state=open]:bg-accent/60"
            >
              {selected ? name(selected) : t("nav.dashboard")}
              <ChevronDown className="size-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </button>
          </DropdownMenuTrigger>
        </h1>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuItem onSelect={() => onSelect("me")} className="gap-3">
            <UserRound className="size-4" />
            <span className="flex-1">{t("dashboards.personal")}</span>
            {current === "me" && <Check className="size-4 text-primary" />}
          </DropdownMenuItem>
          {shared.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("dashboards.shared")}</DropdownMenuLabel>
              {shared.map((d) => <Row key={d.id} d={d} />)}
            </>
          )}
          {priv.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("dashboards.private")}</DropdownMenuLabel>
              {priv.map((d) => <Row key={d.id} d={d} />)}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setDialog({ mode: "create" })} className="gap-3 text-primary focus:text-primary">
            <Plus className="size-4" /> {t("dashboards.new")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {selected && <VisibilityBadge v={selected.visibility} />}

      {selected && (selected.canEdit || selected.canDelete || selected.visibilityOptions.length > 0) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t("dashboards.settings")}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {selected.canEdit && !selected.slug && (
              <DropdownMenuItem onSelect={() => setDialog({ mode: "rename", d: selected })}>
                <Pencil className="size-4" /> {t("dashboards.rename")}
              </DropdownMenuItem>
            )}
            {selected.visibilityOptions.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Eye className="size-4" /> {t("dashboards.whoSees")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-72">
                  <DropdownMenuRadioGroup value={selected.visibility} onValueChange={(v) => update.mutate({ id: selected.id, visibility: v as Visibility })}>
                    {selected.visibilityOptions.map((v) => {
                      const Icon = VIS_ICON[v];
                      return (
                        <DropdownMenuRadioItem key={v} value={v}>
                          <Icon className="size-4" /> {t(`dashboards.vis.${v}`)}
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {selected.canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => window.confirm(t("dashboards.deleteConfirm")) && remove.mutate(selected.id)}>
                  <Trash2 className="size-4" /> {t("common.delete")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <DashboardDialog state={dialog} onClose={() => setDialog(null)} onCreated={(id) => onSelect(id)} />
    </div>
  );
}

function VisibilityBadge({ v }: { v: Visibility }) {
  const { t } = useTranslation();
  const Icon = VIS_ICON[v];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        v === "admins" ? "border-[color:var(--gold)]/40 text-primary" : "text-muted-foreground",
      )}
      title={t(`dashboards.vis.${v}`)}
    >
      <Icon className="size-3" /> {t(`dashboards.visShort.${v}`)}
    </span>
  );
}

function DashboardDialog({
  state,
  onClose,
  onCreated,
}: {
  state: { mode: "create" } | { mode: "rename"; d: DashboardInfo } | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "team">("private");
  useEffect(() => {
    if (!state) return;
    setName(state.mode === "rename" ? state.d.name : "");
    setVisibility("private");
  }, [state]);

  const save = useMutation({
    mutationFn: () =>
      state?.mode === "rename"
        ? api.patch<DashboardInfo>(`/dashboards/${state.d.id}`, { name })
        : api.post<DashboardInfo>("/dashboards", { name, visibility }),
    onSuccess: (d) => {
      // Put it in the list right away so selecting it does not bounce back to "me"
      qc.setQueryData<DashboardInfo[]>(["dashboards"], (old) => [...(old ?? []).filter((x) => x.id !== d.id), d]);
      void qc.invalidateQueries({ queryKey: ["dashboards"] });
      if (state?.mode === "create") onCreated(d.id);
      onClose();
    },
    onError: () => toast.error(t("common.error")),
  });

  return (
    <Dialog open={Boolean(state)} onOpenChange={(o) => !o && onClose()}>
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
            <div className="grid grid-cols-2 gap-2">
              {(["private", "team"] as const).map((v) => {
                const Icon = VIS_ICON[v];
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVisibility(v)}
                    className={cn(
                      "flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors",
                      visibility === v ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10" : "hover:bg-accent/50",
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Icon className="size-4 text-primary" /> {t(`dashboards.visShort.${v}`)}
                    </span>
                    <span className="text-xs text-muted-foreground">{t(`dashboards.vis.${v}`)}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {state?.mode === "rename" ? t("common.save") : t("common.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
