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
        key: "tickets.clients",
        label: { fr: "Créer des clients", en: "Create clients" },
        description: { fr: "Ajouter un nouveau client dans Autotask en créant un billet", en: "Add a new client in Autotask while creating a ticket" },
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
        key: "tickets.planSelf",
        label: { fr: "Planifier ses propres priorités et son calendrier", en: "Plan one's own priorities and calendar" },
        description: {
          fr: "Se donner des priorités du jour / de la semaine et réserver son propre temps",
          en: "Give oneself priorities of the day / week and reserve one's own time",
        },
      },
      {
        key: "tickets.o365",
        label: { fr: "Synchroniser son calendrier Microsoft 365", en: "Sync one's Microsoft 365 calendar" },
        description: {
          fr: "Voir ses événements Outlook dans le calendrier du portail et y envoyer le temps réservé et ses priorités",
          en: "See one's Outlook events in the portal calendar and send reserved time and priorities to it",
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
    key: "crm",
    audience: "staff",
    label: { fr: "Clients", en: "Clients" },
    permissions: [
      { key: "crm.view", label: { fr: "Voir les clients", en: "View clients" }, description: { fr: "Fiches, contacts, contrats et billets des clients", en: "Client records, contacts, contracts and tickets" } },
      {
        key: "crm.edit",
        label: { fr: "Modifier les clients", en: "Edit clients" },
        description: { fr: "Nouveau client, coordonnées, compagnie mère, contacts (aussi dans Autotask tant qu'il est lié)", en: "New client, details, parent company, contacts (in Autotask too while it is linked)" },
      },
      { key: "crm.billing", label: { fr: "Paramètres de facturation", en: "Invoice settings" }, description: { fr: "Courriel de facturation, modalités, taxes, taux", en: "Billing email, terms, taxes, rate" } },
    ],
  },
  {
    key: "timesheets",
    audience: "staff",
    label: { fr: "Feuilles de temps et dépenses", en: "Timesheets and expenses" },
    permissions: [
      {
        key: "timesheets.use",
        label: { fr: "Remplir sa feuille de temps et ses dépenses", en: "Fill in one's timesheet and expenses" },
        description: { fr: "Le temps des billets s'y ajoute seul ; les autres heures et les dépenses s'entrent à la main", en: "Ticket time adds itself; other hours and expenses are entered by hand" },
      },
      {
        key: "timesheets.approve",
        label: { fr: "Approuver les feuilles de temps et dépenses", en: "Approve timesheets and expenses" },
        description: { fr: "Les heures par catégorie seulement (pas le détail) ; les dépenses avec leur reçu", en: "Hours per category only (not the details); expenses with their receipt" },
      },
      {
        key: "timesheets.manage",
        label: { fr: "Gérer les feuilles de temps de tous", en: "Manage everyone's timesheets" },
        description: { fr: "Voir et modifier la feuille de temps de n'importe quel membre de l'équipe, et la soumettre pour lui", en: "See and change any team member's timesheet, and submit it for them" },
      },
    ],
  },
  {
    key: "accounting",
    audience: "staff",
    label: { fr: "Factures, soumissions et approbation", en: "Invoices, quotes and approvals" },
    permissions: [
      { key: "accounting.view", label: { fr: "Voir la comptabilité", en: "View accounting" }, description: { fr: "Factures et soumissions", en: "Invoices and quotes" } },
      {
        key: "accounting.manage",
        label: { fr: "Gérer la facturation", en: "Manage invoicing" },
        description: { fr: "Enregistrer les paiements, approuver et publier (main-d'œuvre, frais, contrats, feuilles de temps, dépenses)", en: "Record payments, approve and post (labour, charges, contracts, timesheets, expenses)" },
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
    key: "sms",
    audience: "staff",
    label: { fr: "Textos (SMS)", en: "Text messages (SMS)" },
    permissions: [
      {
        key: "sms.view",
        label: { fr: "Voir et répondre aux textos", en: "View and answer text messages" },
        description: {
          fr: "Conversations par texto avec les clients (numéro VoIP.ms), et envoi de textos depuis un billet",
          en: "Text conversations with clients (VoIP.ms number), and texts sent from a ticket",
        },
      },
    ],
  },
  {
    key: "outlook",
    audience: "staff",
    label: { fr: "Outlook (courriels)", en: "Outlook (email)" },
    permissions: [
      {
        key: "outlook.view",
        label: { fr: "Utiliser Outlook", en: "Use Outlook" },
        description: {
          fr: "Lier sa propre boîte Microsoft 365 d'AKAB, lire et classer ses courriels",
          en: "Link one's own AKAB Microsoft 365 mailbox, read and organise email",
        },
      },
      {
        key: "outlook.send",
        label: { fr: "Envoyer des courriels", en: "Send email" },
        description: {
          fr: "Répondre, transférer et écrire depuis ses boîtes liées",
          en: "Reply, forward and write from one's linked mailboxes",
        },
      },
      {
        key: "outlook.anyMailbox",
        label: { fr: "Lier d'autres boîtes AKAB", en: "Link other AKAB mailboxes" },
        description: {
          fr: "Boîtes partagées ou d'autres personnes (support@, facturation@…) — donne accès à leurs courriels",
          en: "Shared mailboxes or other people's (support@, billing@…) — gives access to their email",
        },
      },
    ],
  },
  {
    key: "store",
    audience: "staff",
    label: { fr: "Inventaire", en: "Inventory" },
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
    key: "breakroom",
    audience: "staff",
    label: { fr: "Pause café", en: "Coffee break" },
    permissions: [
      {
        key: "breakroom.use",
        label: { fr: "Accéder à la pause café", en: "Use the coffee break" },
        description: { fr: "Jouer aux dames avec un collègue en ligne, regarder les vidéos d'Orbi", en: "Play checkers with an online colleague, watch Orbi's videos" },
      },
    ],
  },
  {
    key: "meetings",
    audience: "staff",
    label: { fr: "Rencontre hebdomadaire", en: "Weekly meeting" },
    permissions: [
      {
        key: "meetings.view",
        label: { fr: "Voir le tableau de bord de la rencontre hebdomadaire", en: "View the weekly meeting dashboard" },
      },
      {
        key: "meetings.manage",
        label: { fr: "Gérer les projets en cours", en: "Manage projects in progress" },
        description: {
          fr: "Ajouter, modifier et terminer des projets, et y prendre des notes",
          en: "Add, edit and complete projects, and take notes on them",
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
        key: "admin.billing",
        label: { fr: "Configurer la facturation", en: "Configure invoicing" },
        description: {
          fr: "Numérotation, taxes, modèle de facture, plan comptable (QuickBooks et Stripe : administrateurs principaux)",
          en: "Numbering, taxes, invoice template, chart of accounts (QuickBooks and Stripe: master administrators)",
        },
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
        key: "admin.o365",
        label: { fr: "Gérer les calendriers Microsoft 365 de tous", en: "Manage everyone's Microsoft 365 calendars" },
        description: {
          fr: "Choisir les calendriers affichés dans la planification de chaque technicien et ce qu'ils montrent (l'accès organisation lit toute boîte d'AKAB)",
          en: "Choose the calendars shown in each technician's planning and what they show (the organisation access reads any AKAB mailbox)",
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
      {
        key: "board.ticket",
        label: { fr: "Poser une question sur un message", en: "Ask a question about a message" },
        description: {
          fr: "Ouvrir un billet de support depuis un message du babillard",
          en: "Open a support ticket from a message board post",
        },
      },
    ],
  },
  // Client portal › Operations
  {
    key: "clientTickets",
    audience: "client",
    label: { fr: "Billets", en: "Tickets" },
    permissions: [
      { key: "clientTickets.view", label: { fr: "Voir ses billets", en: "See one's tickets" }, description: { fr: "Les billets où la personne est le contact", en: "Tickets where the person is the contact" } },
      {
        key: "clientTickets.all",
        label: { fr: "Voir tous les billets de l'entreprise", en: "See all the company's tickets" },
        description: { fr: "Barre de filtres : les billets de tous les usagers de l'entreprise", en: "Filter bar: the tickets of every user of the company" },
      },
      {
        key: "clientTickets.comment",
        label: { fr: "Répondre dans un billet", en: "Reply in a ticket" },
        description: { fr: "Commentaires de suivi, réponses aux questions du technicien", en: "Follow-up comments, answers to the technician's questions" },
      },
      { key: "clientTickets.attach", label: { fr: "Joindre des documents", en: "Attach documents" } },
      {
        key: "clientTickets.escalate",
        label: { fr: "Demander une escalade de priorité", en: "Ask for a priority escalation" },
        description: { fr: "L'équipe AKAB reçoit la demande et décide", en: "The AKAB team receives the request and decides" },
      },
    ],
  },
  {
    key: "clientDevices",
    audience: "client",
    label: { fr: "Appareils", en: "Devices" },
    permissions: [{ key: "clientDevices.view", label: { fr: "Voir les appareils de l'entreprise", en: "See the company's devices" } }],
  },
  {
    key: "clientDocs",
    audience: "client",
    label: { fr: "Documentation", en: "Documentation" },
    permissions: [{ key: "clientDocs.view", label: { fr: "Voir la documentation de l'entreprise", en: "See the company's documentation" } }],
  },
  // Client portal › Accounting
  {
    key: "clientInvoices",
    audience: "client",
    label: { fr: "Factures", en: "Invoices" },
    permissions: [{ key: "clientInvoices.view", label: { fr: "Voir les factures de l'entreprise", en: "See the company's invoices" } }],
  },
  {
    key: "clientQuotes",
    audience: "client",
    label: { fr: "Soumissions", en: "Quotes" },
    permissions: [{ key: "clientQuotes.view", label: { fr: "Voir les soumissions de l'entreprise", en: "See the company's quotes" } }],
  },
  // Client portal › Admin settings (name menu, not the sidebar)
  {
    key: "clientAdmin",
    audience: "client",
    label: { fr: "Paramètres admin", en: "Admin settings" },
    permissions: [
      { key: "clientAdmin.company", label: { fr: "Voir les informations de l'entreprise", en: "See the company information" } },
      { key: "clientAdmin.users", label: { fr: "Voir la liste des usagers de l'entreprise", en: "See the company's user list" } },
    ],
  },
] as const satisfies readonly ModuleDef[];

export type PermissionKey = (typeof MODULES)[number]["permissions"][number]["key"];
export type ModuleKey = (typeof MODULES)[number]["key"];

/**
 * How rights are shown in Roles and access: the sidebar's sections, each
 * with its pages (modules). A whole section can be given at once, or page by
 * page, or right by right. Every module appears exactly once (tested).
 */
export const ACCESS_LAYOUT: { key: string; audience: Audience; label: Localized; modules: ModuleKey[] }[] = [
  { key: "team", audience: "staff", label: { fr: "Équipe", en: "Team" }, modules: ["dashboard", "meetings", "breakroom"] },
  { key: "tools", audience: "staff", label: { fr: "Mes outils", en: "My tools" }, modules: ["outlook", "timesheets"] },
  { key: "command", audience: "staff", label: { fr: "Centre de commande", en: "Command center" }, modules: ["messages", "tickets", "sms"] },
  { key: "management", audience: "staff", label: { fr: "Gestion", en: "Management" }, modules: ["crm", "clientview", "store"] },
  { key: "accounting", audience: "staff", label: { fr: "Comptabilité", en: "Accounting" }, modules: ["accounting"] },
  { key: "admin", audience: "staff", label: { fr: "Paramètres admin", en: "Admin settings" }, modules: ["admin"] },
  { key: "clientBoard", audience: "client", label: { fr: "Babillard", en: "Message board" }, modules: ["board"] },
  { key: "clientOperations", audience: "client", label: { fr: "Opérations", en: "Operations" }, modules: ["clientTickets", "clientDevices", "clientDocs"] },
  { key: "clientAccounting", audience: "client", label: { fr: "Comptabilité", en: "Accounting" }, modules: ["clientInvoices", "clientQuotes"] },
  { key: "clientSettings", audience: "client", label: { fr: "Paramètres admin", en: "Admin settings" }, modules: ["clientAdmin"] },
];

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

export const ADMIN_PERMISSIONS = ["admin.staff", "admin.clients", "admin.billing", "admin.roles", "admin.integrations", "admin.email", "admin.o365"] as const satisfies readonly PermissionKey[];

/** The master administrator role: every right, locked; only its holders give it or act on its holders. */
export const MASTER_ROLE = "administrator";

/**
 * Rights kept for master administrators: whoever holds them can take over
 * the portal (roles and rights, secrets of the integrations and mail server,
 * anyone's mailbox or calendar).
 */
export const MASTER_ONLY: readonly PermissionKey[] = ["admin.roles", "admin.integrations", "admin.email", "admin.o365", "outlook.anyMailbox"];

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
    slug: MASTER_ROLE,
    audience: "staff",
    name: { fr: "Administrateur principal", en: "Master administrator" },
    description: { fr: "Tous les droits, sans exception : rôles, intégrations, connexions Microsoft 365", en: "Every right, no exception: roles, integrations, Microsoft 365 connections" },
    permissions: permissionsFor("staff"),
    locked: true,
  },
  {
    slug: "global-admin",
    audience: "staff",
    name: { fr: "Administrateur global", en: "Global administrator" },
    description: {
      fr: "Gère les techniciens, les clients et leurs usagers, et tout le travail ; pas les rôles, les intégrations ni les calendriers des autres",
      en: "Manages technicians, clients and their users, and all the work; not roles, integrations or other people's calendars",
    },
    permissions: permissionsFor("staff").filter((p) => !MASTER_ONLY.includes(p)),
    locked: false,
  },
  {
    slug: "technician",
    audience: "staff",
    name: { fr: "Technicien", en: "Technician" },
    description: { fr: "Gère ses billets et ses clients", en: "Manages their tickets and clients" },
    permissions: [
      "dashboard.view",
      "tickets.view",
      "tickets.edit",
      "tickets.planSelf",
      "crm.view",
      "timesheets.use",
      "breakroom.use",
      "sms.view",
      "outlook.view",
      "outlook.send",
      "messages.view",
      "messages.post",
      "messages.pin",
      "messages.email",
    ],
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
    description: { fr: "Responsable chez le client : tout le portail client", en: "Person in charge at the client: the whole client portal" },
    permissions: permissionsFor("client"),
    locked: false,
  },
  {
    slug: "client-accounting",
    audience: "client",
    name: { fr: "Comptabilité client", en: "Client accounting" },
    description: { fr: "Babillard, factures et soumissions", en: "Message board, invoices and quotes" },
    permissions: ["board.view", "board.ticket", "clientTickets.view", "clientTickets.comment", "clientTickets.attach", "clientTickets.escalate", "clientInvoices.view", "clientQuotes.view"],
    locked: false,
  },
  {
    slug: "client-tech",
    audience: "client",
    name: { fr: "Technique client", en: "Client technical" },
    description: { fr: "Babillard, billets, appareils et documentation", en: "Message board, tickets, devices and documentation" },
    permissions: ["board.view", "board.ticket", "clientTickets.view", "clientTickets.comment", "clientTickets.attach", "clientTickets.escalate", "clientTickets.all", "clientDevices.view", "clientDocs.view"],
    locked: false,
  },
  {
    slug: "client-config",
    audience: "client",
    name: { fr: "Configuration admin", en: "Admin configuration" },
    description: { fr: "Paramètres admin du portail : informations de l'entreprise et liste des usagers", en: "Portal admin settings: company information and user list" },
    permissions: ["board.view", "board.ticket", "clientTickets.view", "clientTickets.comment", "clientTickets.attach", "clientTickets.escalate", "clientAdmin.company", "clientAdmin.users"],
    locked: false,
  },
  {
    slug: "client-user",
    audience: "client",
    name: { fr: "Usager client", en: "Client user" },
    description: { fr: "Employé du client : le babillard et ses billets", en: "Client employee: the message board and their tickets" },
    permissions: ["board.view", "board.ticket", "clientTickets.view", "clientTickets.comment", "clientTickets.attach", "clientTickets.escalate"],
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
