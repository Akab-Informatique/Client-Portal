import { useEffect, useMemo, useState } from "react";
import { eq } from "drizzle-orm";
import { Search, Trash2, Users } from "lucide-react";
import { db, dbReady, schema } from "@/db";
import type { Company, User } from "@/lib/types";
import { deleteUserById } from "@/lib/deletes";
import { useAuth } from "@/lib/auth";
import { useLocale } from "@/hooks/use-locale";
import { EmptyState } from "@/components/EmptyState";
import { BlurFade } from "@/components/ui/blur-fade";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, roleLabel } from "@/lib/format";

export function UsersPage() {
  const { user: sessionUser } = useAuth();
  const { t } = useLocale();
  const [users, setUsers] = useState<User[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = async () => {
    await dbReady;
    const [u, c] = await Promise.all([
      db.select().from(schema.users),
      db.select().from(schema.companies),
    ]);
    setUsers(
      (u as User[]).sort((a, b) => a.name.localeCompare(b.name)),
    );
    setCompanies(c as Company[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const companyName = useMemo(() => {
    const map = new Map(companies.map((c) => [c.id, c.name]));
    return (id: number | null) => (id ? map.get(id) ?? "—" : "—");
  }, [companies]);

  const filtered = users.filter((u) => {
    if (roleFilter !== "all" && u.role !== roleFilter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      u.name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      companyName(u.company_id).toLowerCase().includes(q)
    );
  });

  const toggleActive = async (user: User) => {
    setActionError(null);
    await dbReady;
    await db
      .update(schema.users)
      .set({ active: !user.active })
      .where(eq(schema.users.id, user.id));
    await load();
  };

  const handleDelete = async (user: User) => {
    setActionError(null);
    if (sessionUser?.id === user.id) {
      setActionError(t("admin.deleteUserSelf"));
      return;
    }
    if (
      !window.confirm(
        t("admin.deleteUserConfirm", { name: user.name }),
      )
    ) {
      return;
    }
    setDeletingId(user.id);
    try {
      const result = await deleteUserById(user.id, {
        actorId: sessionUser?.id ?? null,
      });
      if (!result.ok) {
        setActionError(
          result.error.includes("last active admin")
            ? t("admin.deleteUserLastAdmin")
            : result.error.includes("own account")
              ? t("admin.deleteUserSelf")
              : result.error || t("admin.deleteUserFailed"),
        );
        return;
      }
      await load();
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : t("admin.deleteUserFailed"),
      );
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <BlurFade delay={0.05}>
        <Card>
          <CardHeader>
            <CardTitle>All users</CardTitle>
            <CardDescription>
              Admins, technicians, and client users across every company zone.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative max-w-md flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="Search users…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <Select value={roleFilter} onValueChange={setRoleFilter}>
                <SelectTrigger className="w-full sm:w-44">
                  <SelectValue placeholder="Role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="technician">Technician</SelectItem>
                  <SelectItem value="client">Client user</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {actionError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {actionError}
              </div>
            )}

            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={<Users className="size-5" />}
                title="No users found"
                description="Adjust filters or add clients and technicians from their pages."
              />
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead>Name</TableHead>
                      <TableHead className="hidden md:table-cell">Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead className="hidden lg:table-cell">Company / zone</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden xl:table-cell">Created</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((user) => {
                      const isSelf = sessionUser?.id === user.id;
                      return (
                        <TableRow key={user.id}>
                          <TableCell>
                            <div>
                              <p className="font-medium">{user.name}</p>
                              <p className="text-xs text-muted-foreground md:hidden">
                                {user.email}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">{user.email}</TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={
                                user.role === "admin"
                                  ? "border-primary/40 bg-primary/10 text-primary"
                                  : ""
                              }
                            >
                              {roleLabel(user.role)}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            {companyName(user.company_id)}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={
                                user.active
                                  ? "border-primary/40 bg-primary/10 text-primary"
                                  : ""
                              }
                            >
                              {user.active ? "Active" : "Inactive"}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden text-sm text-muted-foreground xl:table-cell">
                            {formatDate(user.created_at)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1.5">
                              {!isSelf && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void toggleActive(user)}
                                >
                                  {user.active
                                    ? t("admin.deactivateUser")
                                    : t("admin.activateUser")}
                                </Button>
                              )}
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                disabled={isSelf || deletingId === user.id}
                                title={
                                  isSelf
                                    ? t("admin.deleteUserSelf")
                                    : t("admin.deleteUser")
                                }
                                onClick={() => void handleDelete(user)}
                              >
                                <Trash2 className="size-3.5" />
                                {t("admin.deleteUser")}
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </BlurFade>
    </div>
  );
}
