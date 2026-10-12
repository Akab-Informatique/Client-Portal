/**
 * Single source of truth for modules and their granular rights.
 * Used by the API (enforcement) and the UI (sidebar, admin role editor).
 *
 * Adding a module: add an entry to MODULES with its permissions, then guard the
 * API routes with requirePermission("<key>") and give it a sidebar entry.
 */

export type Audience = "staff" | "client";

export type Localized = { fr: string; en: string };

export type PermissionDef = {
  key: string;
  label: Localized;
  description?: Localized;
};

export type ModuleDef = {
  key: string;
  audience: Audience;
  label: Localized;
  permissions: PermissionDef[];
};

export const MODULES = [
  {
    key: "dashboard",
    audience: "staff",
    label: { fr: "Tableau de bord", en: "Dashboard" },
    permissions: [
      { key: "dashboard.view", label: { fr: "Voir le tableau de bord", en: "View dashboard" } },
      {
        key: "dashboard.manage",
        label: { fr: "Gérer les tableaux de bord partagés", en: "Manage shared dashboards" },
        description: {
          fr: "Modifier tous les tableaux partagés (Akab, Sécurité, Clients, Finances…) et décider qui peut les voir ou les modifier",
          en: "Edit every shared dashboard (Akab, Security, Clients, Finance…) and decide who can view or edit them",
        },
      },
    ],
  },
  {
    key: "tickets",
    audience: "staff",
    label: { fr: "Billets", en: "Tickets" },
    permissions: [
      { key: "tickets.view", label: { fr: "Voir les billets", en: "View tickets" } },
      {
        key: "tickets.edit",
        label: { fr: "Créer et modifier des billets", en: "Create and edit tickets" },
        description: { fr: "Nouveau billet, notes, date de début", en: "New ticket, notes, start date" },
      },
      {
        key: "tickets.plan",
        label: { fr: "Planifier et épingler les billets", en: "Plan and pin tickets" },
        description: {
          fr: "Épingler des billets à un technicien avec une directive et réserver du temps dans son calendrier",
          en: "Pin tickets to a technician with a direction and reserve time on their calendar",
        },
      },
      {
        key: "tickets.ai",
        label: { fr: "Utiliser l'assistant IA", en: "Use the AI assistant" },
        description: {
          fr: "Analyse de billet, réponse suggérée, planification (le contenu des billets est envoyé au fournisseur d'IA)",
          en: "Ticket analysis, suggested reply, planning (ticket content is sent to the AI provider)",
        },
      },
    ],
  },
  {
    key: "messages",
    audience: "staff",
    label: { fr: "Babillard", en: "Message board" },
    permissions: [
      { key: "messages.view", label: { fr: "Voir les messages", en: "View messages" } },
      {
        key: "messages.post",
        label: { fr: "Publier des messages", en: "Post messages" },
        description: { fr: "Envoyer à tous les clients ou à une sélection", en: "Send to all clients or a selection" },
      },
      { key: "messages.pin", label: { fr: "Épingler des messages", en: "Pin messages" } },
      {
        key: "messages.email",
        label: { fr: "Envoyer une copie par courriel", en: "Send an email copy" },
        description: {
          fr: "Aux usagers clients ayant activé les notifications",
          en: "To client users who enabled notifications",
        },
      },
      {
        key: "messages.manage",
        label: { fr: "Modifier / supprimer tous les messages", en: "Edit / delete any message" },
      },
    ],
  },
  {
    key: "store",
    audience: "staff",
    label: { fr: "Inventaire boutique", en: "Store inventory" },
    permissions: [
      {
        key: "store.view",
        label: { fr: "Voir l'inventaire", en: "View the inventory" },
        description: { fr: "Produits, prix, stock par emplacement et historique", en: "Products, prices, stock per location and history" },
      },
      {
        key: "store.manage",
        label: { fr: "Gérer l'inventaire", en: "Manage the inventory" },
        description: {
          fr: "Créer et modifier les produits et emplacements, recevoir et ajuster le stock",
          en: "Create and edit products and locations, receive and adjust stock",
        },
      },
    ],
  },
  {
    key: "clientview",
    audience: "staff",
    label: { fr: "Vue client", en: "Client view" },
    permissions: [
      {
        key: "clientview.use",
        label: { fr: "Voir le portail comme un client", en: "View the portal as a client" },
        description: {
          fr: "Basculer vers la vue d'un client choisi (lecture seule)",
          en: "Switch to a chosen client's view (read only)",
        },
      },
    ],
  },
  {
    key: "admin",
    audience: "staff",
    label: { fr: "Paramètres admin", en: "Admin settings" },
    permissions: [
      { key: "admin.staff", label: { fr: "Gérer les techniciens", en: "Manage technicians" } },
      {
        key: "admin.clients",
        label: { fr: "Gérer les clients et leurs usagers", en: "Manage clients and their users" },
      },
      {
        key: "admin.roles",
        label: { fr: "Gérer les rôles et les accès", en: "Manage roles and access" },
      },
      {
        key: "admin.email",
        label: { fr: "Gérer les courriels (SMTP et modèles)", en: "Manage email (SMTP and templates)" },
        description: {
          fr: "Configurer le serveur d'envoi et modifier les modèles de courriels",
          en: "Configure the outgoing mail server and edit the email templates",
        },
      },
      {
        key: "admin.integrations",
        label: { fr: "Gérer les intégrations (Autotask)", en: "Manage integrations (Autotask)" },
        description: {
          fr: "Configurer la connexion Autotask et lier les techniciens à leur utilisateur Autotask",
          en: "Configure the Autotask connection and link technicians to their Autotask user",
        },
      },
    ],
  },
  {
    key: "board",
    audience: "client",
    label: { fr: "Babillard", en: "Message board" },
    permissions: [
      { key: "board.view", label: { fr: "Recevoir les messages d'AKAB", en: "Receive AKAB messages" } },
    ],
  },
] as const satisfies readonly ModuleDef[];

export type PermissionKey = (typeof MODULES)[number]["permissions"][number]["key"];

export const ALL_PERMISSIONS: readonly PermissionKey[] = MODULES.flatMap((m) =>
  m.permissions.map((p) => p.key as PermissionKey),
);

export function permissionsFor(audience: Audience): PermissionKey[] {
  return MODULES.filter((m) => m.audience === audience).flatMap((m) =>
    m.permissions.map((p) => p.key as PermissionKey),
  );
}

export function isPermissionKey(v: unknown): v is PermissionKey {
  return typeof v === "string" && (ALL_PERMISSIONS as readonly string[]).includes(v);
}

export const ADMIN_PERMISSIONS = ["admin.staff", "admin.clients", "admin.roles", "admin.integrations", "admin.email"] as const satisfies readonly PermissionKey[];

/** Predefined roles, created on first start. System roles cannot be deleted. */
export const SYSTEM_ROLES: Array<{
  slug: string;
  audience: Audience;
  name: Localized;
  description: Localized;
  permissions: PermissionKey[];
  locked: boolean;
}> = [
  {
    slug: "administrator",
    audience: "staff",
    name: { fr: "Administrateur", en: "Administrator" },
    description: { fr: "Accès complet, incluant les paramètres admin", en: "Full access, including admin settings" },
    permissions: permissionsFor("staff"),
    locked: true,
  },
  {
    slug: "technician",
    audience: "staff",
    name: { fr: "Technicien", en: "Technician" },
    description: { fr: "Travail quotidien : babillard et tableau de bord", en: "Day-to-day work: board and dashboard" },
    permissions: ["dashboard.view", "tickets.view", "tickets.edit", "messages.view", "messages.post", "messages.pin", "messages.email"],
    locked: false,
  },
  {
    slug: "viewer",
    audience: "staff",
    name: { fr: "Lecture seule", en: "Read only" },
    description: { fr: "Consultation sans modification", en: "View without changes" },
    permissions: ["dashboard.view", "messages.view"],
    locked: false,
  },
  {
    slug: "client-admin",
    audience: "client",
    name: { fr: "Administrateur client", en: "Client administrator" },
    description: { fr: "Responsable TI chez le client", en: "IT contact at the client" },
    permissions: ["board.view"],
    locked: false,
  },
  {
    slug: "client-user",
    audience: "client",
    name: { fr: "Usager client", en: "Client user" },
    description: { fr: "Employé du client", en: "Client employee" },
    permissions: ["board.view"],
    locked: false,
  },
];

export type Override = { key: PermissionKey; effect: "allow" | "deny" };

/** Role rights + direct grants − direct denials, limited to the user's audience. */
export function effectivePermissions(
  audience: Audience,
  rolePermissions: readonly string[],
  overrides: readonly Override[],
): PermissionKey[] {
  const allowed = new Set(permissionsFor(audience));
  const out = new Set<PermissionKey>();
  for (const p of rolePermissions) if (isPermissionKey(p) && allowed.has(p)) out.add(p);
  for (const o of overrides) {
    if (!allowed.has(o.key)) continue;
    if (o.effect === "allow") out.add(o.key);
    else out.delete(o.key);
  }
  return [...out].sort();
}

export function isAdmin(perms: readonly string[]): boolean {
  return ADMIN_PERMISSIONS.some((p) => perms.includes(p));
}
