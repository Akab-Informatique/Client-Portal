/**
 * Sample tickets to design and try the Tickets screens before they are wired
 * to Autotask. Same shape as what the Autotask connector will return, so the
 * UI does not change when the data becomes real. Kept in memory (lost on restart).
 */
export type TicketStatus = "new" | "inProgress" | "needsAttention" | "waitingCustomer" | "waitingVendor" | "scheduled" | "complete";
export type TicketPriority = "critical" | "high" | "medium" | "low";
export type Person = { id: string; name: string };
export type Note = { id: string; author: string; at: string; text: string; internal: boolean };
export type Ticket = {
  id: number;
  number: string;
  title: string;
  description: string;
  company: { id: number; name: string };
  contact: string;
  contactId: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  queue: string;
  source: "email" | "phone" | "portal" | "monitoring";
  assignee: Person | null;
  /** Secondary resources (Autotask) */
  secondary: Person[];
  createdAt: string;
  dueAt: string;
  updatedAt: string;
  hours: number;
  notes: Note[];
};

export const QUEUES = ["Support niveau 1", "Support niveau 2", "Réseau et sécurité", "Projets"];
const COMPANIES = [
  "Clinique dentaire Joliette",
  "Transport Lanaudière",
  "Notaires Brisebois & Associés",
  "Municipalité de Saint-Lin",
  "Boulangerie Rive-Nord",
  "Comptables Desrosiers CPA",
  "Garage Mécano Plus",
  "Pharmacie Rawdon",
];
const CONTACTS = ["Julie Gagnon", "Marc Lévesque", "Sophie Bergeron", "Éric Paquette", "Nathalie Roy", "Patrick Ouellet", "Isabelle Côté", "Luc Bélanger"];
const SUBJECTS: [string, string][] = [
  ["Imprimante de la réception hors ligne", "L'imprimante HP de la réception n'imprime plus depuis ce matin. Le voyant réseau clignote orange."],
  ["Courriels non reçus sur Outlook", "Depuis 9 h, aucun courriel externe n'entre dans les boîtes de la comptabilité."],
  ["Nouvel employé : création de compte", "Arrivée de Maxime Tremblay lundi : compte Microsoft 365, accès aux dossiers partagés et poste de travail."],
  ["VPN déconnecte toutes les 10 minutes", "Les employés en télétravail perdent la connexion VPN régulièrement."],
  ["Alerte : disque presque plein sur SRV-FICHIERS", "Le volume D: du serveur de fichiers est à 94 %."],
  ["Mise à jour du pare-feu FortiGate", "Planifier la mise à jour du micrologiciel du pare-feu vers la dernière version stable."],
  ["Poste lent au démarrage", "Le poste de Sophie prend plus de 5 minutes à démarrer."],
  ["Licence Adobe expirée", "Acrobat Pro demande une réactivation sur 3 postes."],
  ["Wi-Fi invité ne fonctionne plus", "Les clients en salle d'attente ne peuvent plus se connecter au réseau invité."],
  ["Sauvegarde nocturne en échec", "La tâche de sauvegarde Veeam du serveur principal a échoué deux nuits de suite."],
  ["Migration vers Microsoft 365", "Projet de migration des boîtes Exchange locales vers Microsoft 365 (25 utilisateurs)."],
  ["Écran noir sur le portable du directeur", "Le portable démarre mais l'écran reste noir. Écran externe fonctionnel."],
  ["Hameçonnage signalé", "Un employé a cliqué sur un lien suspect dans un courriel se faisant passer pour la banque."],
  ["Téléphone IP sans tonalité", "Le poste 214 n'a plus de tonalité depuis le déménagement du bureau."],
  ["Remplacement du serveur (fin de garantie)", "Évaluer et planifier le remplacement du serveur Dell arrivé en fin de garantie."],
];

/**
 * Generated tickets keep a "slot" instead of a fixed person: the assignee is
 * resolved against the current technicians on every read, so accounts created
 * later (or after a restart) get their share. Tickets created in the portal
 * keep their chosen assignee (slot null).
 */
type Stored = Ticket & { slot: number | null; secondarySlots: number[]; secondaryFixed?: Person[] };
let store: Stored[] | null = null;
let nextId = 41000;

// Small deterministic generator: the same sample set on every start
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}
const pick = <T>(r: () => number, a: readonly T[]) => a[Math.floor(r() * a.length)];
const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

/** All sample tickets; assignees are the current technicians (round robin). */
export function demoTickets(staff: Person[]): Ticket[] {
  store ??= generate();
  return store.map(({ slot, secondarySlots, secondaryFixed, ...t }) => {
    const assignee = slot === null ? t.assignee : staff.length ? staff[slot % staff.length] : null;
    const secondary = staff.length
      ? [...new Map(secondarySlots.map((s) => staff[s % staff.length]).filter((p) => p.id !== assignee?.id).map((p) => [p.id, p])).values()]
      : [];
    return { ...t, assignee, secondary: secondaryFixed ?? secondary };
  });
}

function generate(): Stored[] {
  const r = rng(42);
  const now = Date.now();
  const H = 3600_000;
  const statuses: TicketStatus[] = ["new", "inProgress", "inProgress", "needsAttention", "waitingCustomer", "waitingVendor", "scheduled", "complete"];
  const priorities: TicketPriority[] = ["critical", "high", "high", "medium", "medium", "medium", "low", "low"];
  const list: Stored[] = Array.from({ length: 36 }, (_, i) => {
    const [title, description] = SUBJECTS[i % SUBJECTS.length];
    const created = new Date(now - Math.floor(r() * 12 * 24) * H);
    const status = i < 5 ? "new" : pick(r, statuses);
    const priority = /Alerte|Hameçonnage|Sauvegarde|Courriels/.test(title) ? (r() > 0.5 ? "critical" : "high") : pick(r, priorities);
    const due = new Date(now + (Math.floor(r() * 10 * 24) - 3 * 24) * H);
    const unassigned = status === "new" && r() > 0.3;
    const slot = unassigned ? null : i;
    const author = "AKAB Informatique";
    const company = { id: 300 + (i % COMPANIES.length), name: COMPANIES[i % COMPANIES.length] };
    const contact = CONTACTS[(i * 3) % CONTACTS.length];
    const notes: Note[] = [];
    const n = Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      notes.push({
        id: `n${i}-${k}`,
        author: k % 2 === 0 ? author : contact,
        at: new Date(created.getTime() + (k + 1) * 3 * H).toISOString(),
        text:
          k % 2 === 0
            ? pick(r, ["Prise en charge, je regarde à distance.", "Redémarrage du service effectué, à surveiller.", "Commande de la pièce chez le fournisseur.", "Rendez-vous planifié sur place."])
            : pick(r, ["Merci, c'est revenu pour l'instant.", "Le problème est revenu ce matin.", "Je serai disponible après 13 h."]),
        internal: k % 2 === 0 && r() > 0.5,
      });
    }
    return {
      id: 40000 + i,
      number: `T${ymd(created)}.${String(40 + i).padStart(4, "0")}`,
      title,
      description,
      company,
      contact,
      contactId: `c-${company.id}-0`,
      status,
      priority,
      queue: /Projet|Migration|Remplacement|Mise à jour/.test(title) ? "Projets" : /VPN|pare-feu|Wi-Fi|Hameçonnage/.test(title) ? "Réseau et sécurité" : pick(r, QUEUES.slice(0, 2)),
      source: /Alerte|Sauvegarde/.test(title) ? "monitoring" : pick(r, ["email", "phone", "portal"] as const),
      assignee: null,
      slot,
      secondarySlots: unassigned ? [] : i % 5 === 0 ? [i + 1, i + 2] : i % 3 === 0 ? [i + 1] : [],
      secondary: [],
      createdAt: created.toISOString(),
      dueAt: due.toISOString(),
      updatedAt: (notes.at(-1)?.at ?? created.toISOString()),
      hours: Math.round(r() * 60) / 10,
      notes,
    } satisfies Stored;
  });
  return list;
}

export function addDemoTicket(t: Omit<Ticket, "id" | "number" | "createdAt" | "updatedAt" | "hours" | "notes" | "secondary">): Ticket {
  const created = new Date();
  const ticket: Ticket = {
    ...t,
    id: nextId++,
    number: `T${ymd(created)}.${String(nextId % 10000).padStart(4, "0")}`,
    createdAt: created.toISOString(),
    updatedAt: created.toISOString(),
    hours: 0,
    notes: [],
    secondary: [],
  };
  store?.unshift({ ...ticket, slot: null, secondarySlots: [] });
  return ticket;
}

/** Change fields of a sample ticket (an explicit assignee replaces the round-robin slot). */
export function updateDemoTicket(
  id: number,
  p: Partial<Pick<Ticket, "status" | "priority" | "queue" | "dueAt" | "company" | "contact" | "contactId" | "title" | "description">> & {
    assignee?: Person | null;
    secondary?: Person[];
  },
): boolean {
  const t = store?.find((x) => x.id === id);
  if (!t) return false;
  Object.assign(t, p, { updatedAt: new Date().toISOString() });
  if ("assignee" in p) t.slot = null;
  if (p.secondary) {
    t.secondaryFixed = p.secondary;
    delete (t as Partial<Ticket>).secondary;
  }
  return true;
}

export function addDemoNote(id: number, note: Omit<Note, "id" | "at">): Note | null {
  const t = store?.find((x) => x.id === id);
  if (!t) return null;
  const n: Note = { ...note, id: `n${id}-${Date.now()}`, at: new Date().toISOString() };
  t.notes.push(n);
  t.updatedAt = n.at;
  return n;
}

/** A time entry shown in the sample ticket's activity. */
export function addDemoTimeEntry(id: number, p: { author: string; hours: number; text: string; internalText?: string; at: string }): boolean {
  const t = store?.find((x) => x.id === id);
  if (!t) return false;
  t.notes.push({ id: `t${id}-${Date.now()}`, author: p.author, at: p.at, text: p.text, internal: false, ...({ kind: "time", hours: p.hours, internalText: p.internalText } as object) });
  t.hours = Math.round((t.hours + p.hours) * 100) / 100;
  t.updatedAt = new Date().toISOString();
  return true;
}

export const demoCompanies = () => COMPANIES.map((name, i) => ({ id: 300 + i, name }));

// ── Contacts per client (Autotask "Contacts") ──
export type Contact = { id: string; companyId: number; name: string; email: string | null; phone: string | null };
let contacts: Contact[] | null = null;
const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, ".");

function allContacts(): Contact[] {
  contacts ??= COMPANIES.flatMap((company, c) =>
    [0, 1, 2].map((k) => {
      const name = CONTACTS[(c * 3 + k) % CONTACTS.length];
      return {
        id: `c-${300 + c}-${k}`,
        companyId: 300 + c,
        name,
        email: `${slug(name)}@${slug(company).replace(/\.+$/, "")}.ca`,
        phone: `450-555-${String(1000 + c * 10 + k)}`,
      };
    }),
  );
  return contacts;
}

export const demoContacts = (companyId: number) => allContacts().filter((x) => x.companyId === companyId);
export const demoContact = (id: string) => allContacts().find((x) => x.id === id) ?? null;

export function addDemoContact(p: Omit<Contact, "id">): Contact {
  const list = allContacts();
  const c: Contact = { ...p, id: `c-${p.companyId}-${Date.now()}` };
  list.push(c);
  return c;
}
