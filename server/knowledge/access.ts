/**
 * Who may be told about each part of CLAUDE.md (the portal assistant's knowledge). Reviewed by hand.
 *
 * DEFAULT DENY: a section that is not in SECTION_ACCESS is never shown to anyone (the generator leaves it out of
 * server/knowledge/portal.json). Developer-only sections (Branches, Commands, Adding a module, Production) are
 * deliberately absent.
 *
 * SECTION_ACCESS: the heading exactly as written after "## " in CLAUDE.md → the rights; the user needs ANY of them.
 * RESTRICTIONS: a part of a section whose text matches a pattern is shown only to those who hold ANY right of each
 * matching group (in addition to the section's own rights). They only ever narrow what a section shows.
 *
 * The generator (scripts/build-knowledge.mjs) runs these rules and writes the result into portal.json; a test
 * checks that the JSON still agrees with this file.
 */

export const SECTION_ACCESS: Record<string, string[]> = {
  "Weekly meeting (Rencontre hebdomadaire)": ["meetings.view"],
  "Pause café (coffee break)": ["breakroom.use"],
  // mixes the Outlook explanation (for those who use it) with the organisation access and Entra set-up (admins)
  "Roles and Microsoft 365": ["outlook.view", "admin.roles", "admin.o365"],
  // a long reference for the whole CRM, billing and time side; every bullet is narrowed by RESTRICTIONS below
  "CRM and the portal's own data": ["crm.view", "accounting.view", "admin.clients", "admin.billing"],
  "Projets (Centre de commande › Projets)": ["projects.view"],
  "Pipeline (My tools › Pipeline)": ["pipeline.view"],
  // the time side is for everyone who fills a timesheet; the HR parts (wages, bank, payroll) are narrowed below
  "Heures payées, RH et temps facturable (Feuille de temps, Gestion › RH)": ["timesheets.use", "hr.manage"],
  "Checkpoint, + button, meeting points (latest)": ["tickets.view", "meetings.view"],
  "Pipeline layout, dates on tickets, meeting order (latest)": ["pipeline.view", "tickets.view"],
  "AI assistant of the tickets page": ["tickets.ai"],
  "Tickets: views, tags, chat, notes (latest)": ["tickets.view"],
  "Running on its own (no Autotask, never sample data in production)": ["admin.integrations"],
  "Workflows (Admin › Flux de travail)": ["admin.workflows"],
  "Ticket queues (Admin › Files d'attente)": ["admin.queues"],
  "Contract types, contracts by hand, Services": ["crm.view", "services.view", "accounting.view"],
  "ITCloud (vendor; Admin › Intégrations › ITCloud)": ["admin.integrations"],
  "Datto RMM (Admin › Intégrations › RMM)": ["admin.integrations"],
  "Service prices and the contracts that use them": ["services.view", "crm.billing"],
  "Ventes (sales pipeline and dashboard)": ["opportunities.view"],
  "Quotes (Soumissions)": ["quotes.view", "accounting.view"],
  "Sécurité › Passbolt (spike)": ["admin.integrations"],
  "Public legal pages": ["admin.integrations"],
  "Client portal (what clients see now)": ["admin.clients", "crm.view"],
  "Paiements fournisseurs (Comptabilité › Paiements fournisseurs)": ["accounting.view"],
  "Contracts paid automatically by card (latest)": ["crm.view", "accounting.view"],
  "Message board: main and billing contacts (latest)": ["messages.view"],
  "Paying an invoice by card from the client portal (latest)": ["accounting.view", "crm.view"],
  // how sign-in and the server protect things: developers and administrators only
  "Security rules": ["admin.roles", "admin.integrations"],
  "Email text in tickets (latest)": ["tickets.view"],
  "Time under no contract (latest)": ["accounting.view", "timesheets.approve"],
  "Hours bank contracts (latest)": ["crm.view", "accounting.view"],
  "Parent and child companies, hours bank adjustments (latest)": ["crm.view", "accounting.view"],
  "Rebates (rabais)": ["accounting.view", "crm.view", "quotes.view"],
  "Documentation (Centre de commande › Documentation)": ["sops.view", "kb.view"],
  "Procédures (SOP) (My tools › Procédures)": ["sops.view"],
  "Ma journée: done blocks and AI refresh (latest)": ["pipeline.view"],
  "Ticket hue from the checkpoint (latest)": ["tickets.view"],
  "Pipeline tasks: checkpoint, no times, all tasks (latest)": ["pipeline.view"],
  "Pipeline: continuous tasks and dated checklist items (latest)": ["pipeline.view"],
  "Pipeline: three kinds of task (latest)": ["pipeline.view"],
  "Pipeline: a ticket put on my day by hand (latest)": ["pipeline.view"],
  "Compact ticket view columns (latest)": ["tickets.view"],
  "Pipeline: checklist items you can assign, and make into subtasks (latest)": ["pipeline.view"],
  "Pipeline: the task reworked (latest)": ["pipeline.view"],
  "Projets reworked: creation, phases, overview (latest)": ["projects.view"],
  "Minimized tickets in a drawer, opened by a floating logo (latest)": ["tickets.view"],
  "Client portal: accounts made by hand (latest)": ["admin.clients"],
  "Moving a ticket to another client (latest)": ["tickets.edit"],
  "Quote deposit invoice (latest)": ["quotes.view", "accounting.view"],
  "Projects sold from a quote, tickets tied to a project (latest)": ["projects.view", "quotes.view"],
  "Invoice numbers free in QuickBooks too (latest)": ["accounting.view"],
  "Credit notes (notes de crédit) and fixing a QuickBooks error from the list (latest)": ["accounting.view"],
  "Deposit on some lines only (latest)": ["quotes.view", "accounting.view"],
  "Moving a charge, and whose project time it is (latest)": ["tickets.edit", "projects.view"],
  "A ticket turned into a project (latest)": ["tickets.edit", "projects.view"],
  "Ma journée: time given to each item, in quarter hours (latest)": ["pipeline.view"],
  "Project tasks: contract, waiting, order; each technician's own sort (latest)": ["projects.view"],
  "Ma journée on days off, project windows in the drawer, tasks by hand (latest)": ["pipeline.view"],
  "Ma journée: today's checkpoint is the start time (latest)": ["pipeline.view"],
  "Ma journée: late items are not planned, project tasks can be added by hand (latest)": ["pipeline.view"],
  "Checkpoint after the due date is flagged (latest)": ["tickets.view"],
  "Ma journée: the daily plan is manual for now (latest)": ["pipeline.view"],
  "Approbation by month, and project time under Jalons (latest)": ["accounting.view"],
  "Operations: projects that flash, and staying in Operations (latest)": ["pipeline.view", "projects.view"],
  "Sale types: fixed price, bank of hours, hourly (latest)": ["quotes.view", "projects.view"],
  "A phase works like a ticket (latest)": ["projects.view"],
  "Ma journée: the projects table (latest)": ["pipeline.view"],
  "To-do tasks: activity and time like a project phase (latest)": ["pipeline.view"],
  "Sidebar favourites (latest)": ["assistant.use"],
  // API keys are for administrators only
  "API keys for outside tools (Grok…) (latest)": ["admin.integrations"],
  "Newsletter (Gestion › Infolettre) (latest)": ["newsletter.view"],
  "Charges on a project (latest)": ["projects.view"],
  "Ma journée: events can be moved in the plan (latest)": ["pipeline.view"],
  "Pause and play on a project task, ticket window scroll, narrow Projets (latest)": ["projects.view"],
  "Notes are saved as you type (latest)": ["assistant.use"],
  "Credit on a client's account in QuickBooks (latest)": ["accounting.view"],
  "Quote products become project charges; ordered / received (latest)": ["quotes.view", "projects.view"],
  "Project types (latest)": ["projects.view"],
  "Technician time SKU, and the charges shown when a quote becomes a project (latest)": ["quotes.view", "projects.view"],
  "Hours bank: top-up keeps every hour left (latest)": ["crm.view", "accounting.view"],
  "Self-managed clients, delegated technicians, company switcher (latest)": ["tickets.selfManaged", "admin.clients"],
  "Hours bank that tops up: the schedule shows what will really be bought (latest)": ["crm.view", "accounting.view"],
  "To-do lists: every task is on a list; the Tasks section (latest)": ["pipeline.view"],
};

/** Keyword rules that narrow a part of a section. The text of each part is tested; every matching group must be held. */
export const RESTRICTIONS: { name: string; pattern: RegExp; requires: string[] }[] = [
  // wages, payroll, the HR file, the vacation and hours banks of employees
  {
    name: "hr",
    pattern: /\b(salaire|salary|wages?|hourly wage|paie|payroll|hr_ledger|hr_profiles|dossier RH|RH file|vacation bank|sick days|jours de maladie|holiday pay|férié|bank in \$|RH|HR)\b/i,
    requires: ["hr.manage"],
  },
  // secrets, keys, sealed values and webhooks: administrators only
  {
    name: "secrets",
    pattern: /\b(secret|sealed|scellé|scellée|scellés|API key|clé d'API|whsec|APP_SECRET|bearer|refresh token|webhook)\b/i,
    requires: ["admin.integrations"],
  },
  // sign-in provider internals
  {
    name: "oauth",
    pattern: /\b(Intuit|OAuth|PKCE)\b/,
    requires: ["admin.integrations"],
  },
  // "Admin › <section>" in a part: the right of that admin section (every one named must be held)
  { name: "admin: Facturation", pattern: /Admin\s*›[^\n]{0,80}?Facturation/, requires: ["admin.billing"] },
  { name: "admin: Types de contrats", pattern: /Admin\s*›[^\n]{0,80}?Types de contrats/, requires: ["admin.billing"] },
  { name: "admin: Fournisseurs", pattern: /Admin\s*›[^\n]{0,80}?Fournisseurs/, requires: ["admin.billing"] },
  { name: "admin: Temps et dépenses", pattern: /Admin\s*›[^\n]{0,80}?Temps et dépenses/, requires: ["admin.billing"] },
  { name: "admin: Intégrations", pattern: /Admin\s*›[^\n]{0,80}?Intégrations/, requires: ["admin.integrations"] },
  { name: "admin: Courriel entrant", pattern: /Admin\s*›[^\n]{0,80}?Courriel entrant/, requires: ["outlook.anyMailbox"] },
  { name: "admin: Courriel", pattern: /Admin\s*›[^\n]{0,80}?Courriel(?! entrant)/, requires: ["admin.email"] },
  { name: "admin: Classifications", pattern: /Admin\s*›[^\n]{0,80}?Classifications/, requires: ["admin.classes"] },
  { name: "admin: Files d'attente", pattern: /Admin\s*›[^\n]{0,80}?Files d'attente/, requires: ["admin.queues"] },
  { name: "admin: Flux de travail", pattern: /Admin\s*›[^\n]{0,80}?Flux de travail/, requires: ["admin.workflows"] },
  { name: "admin: Billets", pattern: /Admin\s*›[^\n]{0,80}?Billets/, requires: ["admin.tickets"] },
  { name: "admin: Rôles", pattern: /Admin\s*›[^\n]{0,80}?(Rôles|Roles)/, requires: ["admin.roles"] },
];

/** The rule groups a part of a section must satisfy (empty when none applies). */
export function restrictionsOf(text: string): string[][] {
  const out: string[][] = [];
  for (const r of RESTRICTIONS) if (r.pattern.test(text)) out.push(r.requires);
  return out;
}
