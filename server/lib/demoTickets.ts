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
  /** Device (Autotask configuration item) */
  assetId: string | null;
  /** Contract the work is billed on (Autotask contract) */
  contractId?: string | null;
  /** Files attached in the portal */
  attachments?: { id: string; name: string; size: number; at: string; author: string }[];
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
      assetId: i % 3 === 0 ? `a-${company.id}-0` : i % 3 === 1 ? `a-${company.id}-2` : null,
    } satisfies Stored;
  });
  return list;
}

export function addDemoTicket(t: Omit<Ticket, "id" | "number" | "createdAt" | "updatedAt" | "hours" | "notes" | "secondary" | "assetId">): Ticket {
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
    assetId: null,
  };
  store?.unshift({ ...ticket, slot: null, secondarySlots: [] });
  return ticket;
}

/** Change fields of a sample ticket (an explicit assignee replaces the round-robin slot). */
/** Other contacts of the sample tickets (Autotask "additional contacts"): ticket id → contact ids */
const otherContacts = new Map<number, Set<string>>();
export function setDemoOtherContacts(ticketId: number, contactIds: string[]) {
  otherContacts.set(ticketId, new Set(contactIds));
}
export function demoTicketsWithOtherContact(contactId: string): number[] {
  return [...otherContacts].filter(([, ids]) => ids.has(contactId)).map(([id]) => id);
}

export function addDemoAttachment(id: number, p: { name: string; size: number; author: string }): boolean {
  const t = store?.find((x) => x.id === id);
  if (!t) return false;
  (t.attachments ??= []).push({ id: `f-${id}-${t.attachments.length + 1}`, ...p, at: new Date().toISOString() });
  return true;
}

export function updateDemoTicket(
  id: number,
  p: Partial<Pick<Ticket, "status" | "priority" | "queue" | "dueAt" | "company" | "contact" | "contactId" | "title" | "description" | "assetId">> & {
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

/** Clients created in the portal (sample data, in memory) */
const addedCompanies: { id: number; name: string }[] = [];
export const demoCompanies = () => [...COMPANIES.map((name, i) => ({ id: 300 + i, name })), ...addedCompanies];
/**
 * A year of ticket history for the meeting trends (sample data): each day's
 * tickets and when they were resolved. Seeded by the day, so the same day
 * always gives the same tickets, after a restart too.
 */
export function demoHistory(sinceMs: number): { id: number; createdAt: string; completedAt: string | null; queue: string; source: string; priority: string }[] {
  const DAY = 86_400_000;
  const H = 3_600_000;
  const now = Date.now();
  const out: ReturnType<typeof demoHistory> = [];
  const first = Math.floor(sinceMs / DAY) - 30; // tickets created a little before still get resolved in the range
  const last = Math.floor(now / DAY);
  for (let day = first; day <= last; day++) {
    // small seeded generator (mulberry32)
    let a = (day * 2654435761) >>> 0;
    const rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const dow = new Date(day * DAY).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    // a slow seasonal swing, busier on Mondays, few tickets on weekends
    const season = 1 + 0.25 * Math.sin((day / 365) * 2 * Math.PI);
    const n = weekend ? Math.floor(rand() * 3) : Math.round((7 + rand() * 6) * season * (dow === 1 ? 1.3 : 1));
    for (let i = 0; i < n; i++) {
      const created = day * DAY + (weekend ? 10 : 13) * H + Math.floor(rand() * 9 * H);
      // resolution: most within a day or two, a long tail of waiting ones
      const r = rand();
      const hours = r < 0.35 ? 0.5 + rand() * 6 : r < 0.75 ? 6 + rand() * 42 : r < 0.93 ? 48 + rand() * 120 : 168 + rand() * 500;
      const done = created + hours * H;
      out.push({
        id: 900000 + (day % 100000) * 40 + i,
        createdAt: new Date(created).toISOString(),
        completedAt: done <= now ? new Date(done).toISOString() : null,
        queue: QUEUES[Math.floor(rand() * QUEUES.length)],
        source: rand() < 0.5 ? "Courriel" : "Téléphone",
        priority: ["critical", "high", "medium", "low"][Math.min(3, Math.floor(rand() * 4.4))],
      });
    }
  }
  return out.filter((t) => Date.parse(t.createdAt) >= sinceMs || (t.completedAt && Date.parse(t.completedAt) >= sinceMs));
}

export function addDemoCompany(name: string, id?: number) {
  // a given id (the portal client's link) is kept when free, so it survives restarts
  const free = id != null && id > 0 && !demoCompanies().some((x) => x.id === id);
  const c = { id: free ? id : Math.max(300 + COMPANIES.length, ...demoCompanies().map((x) => x.id + 1)), name };
  addedCompanies.push(c);
  return c;
}

/**
 * Sample tickets for the portal's own client companies (local demo only):
 * each one gets a ticket company of the same name, its client users as
 * contacts (matched by email, so their tickets are "theirs"), and a few
 * tickets in every state. Built the same way after every restart.
 */
const seededClients = new Set<string>();
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
let clientTicketNo = 0;
export function ensureClientSamples(clients: { name: string; phone: string | null; autotaskId: number | null; users: { name: string; email: string }[] }[]) {
  store ??= generate();
  const H = 3600_000;
  const now = Date.now();
  // subjects a client would write (no monitoring alerts)
  const subjects = SUBJECTS.filter(([t]) => !/Alerte|Sauvegarde/.test(t));
  for (const cl of clients) {
    const key = cl.name.trim().toLowerCase();
    if (seededClients.has(key) || !cl.users.length) continue;
    seededClients.add(key);
    const company = demoCompanies().find((x) => x.name.trim().toLowerCase() === key) ?? addDemoCompany(cl.name, cl.autotaskId ?? undefined);
    const people = cl.users.map(
      (u) =>
        allContacts().find((c) => c.companyId === company.id && c.email?.toLowerCase() === u.email.toLowerCase()) ??
        // same id after every restart, so the CRM copy does not see them leave
        addDemoContact({ companyId: company.id, name: u.name, email: u.email, phone: cl.phone }, `c-${company.id}-p${hash(u.email.toLowerCase())}`),
    );
    const h = hash(key);
    const plans: { status: TicketStatus; priority: TicketPriority; ageH: number; dueH: number; talk: number; unassigned?: boolean; question?: boolean; secondary?: boolean }[] = [
      { status: "new", priority: "medium", ageH: 3, dueH: 45, talk: 0, unassigned: true },
      { status: "inProgress", priority: "high", ageH: 30, dueH: 18, talk: 3, secondary: true },
      { status: "waitingCustomer", priority: "medium", ageH: 52, dueH: 30, talk: 2, question: true },
      { status: "scheduled", priority: "low", ageH: 70, dueH: 96, talk: 1 },
      { status: "inProgress", priority: "critical", ageH: 100, dueH: -6, talk: 2 },
      { status: "waitingVendor", priority: "medium", ageH: 140, dueH: 72, talk: 2 },
      { status: "complete", priority: "medium", ageH: 220, dueH: -120, talk: 3 },
      // older history (the portal shows every resolved ticket)
      { status: "complete", priority: "low", ageH: 24 * 64, dueH: -24 * 60, talk: 3 },
      { status: "complete", priority: "high", ageH: 24 * 210, dueH: -24 * 208, talk: 3 },
    ];
    plans.forEach((p, k) => {
      const [title, description] = subjects[(h + k * 5) % subjects.length];
      const contact = people[k % people.length];
      const created = new Date(now - p.ageH * H);
      const notes: Note[] = [];
      const tech = [
        "Prise en charge. Je regarde à distance dès que possible.",
        "Diagnostic fait : le pilote réseau était corrompu, réinstallé. À surveiller.",
        "Pièce commandée chez le fournisseur, livraison prévue en début de semaine.",
        "Intervention terminée, tout fonctionne. Merci de votre patience !",
      ];
      const client = ["Merci, c'est noté.", "Le problème est revenu ce matin vers 9 h.", "Parfait, merci beaucoup !"];
      for (let i = 0; i < p.talk; i++) {
        const fromTech = i % 2 === 0;
        notes.push({
          id: `cn${h}-${k}-${i}`,
          author: fromTech ? "Équipe AKAB" : contact.name,
          at: new Date(created.getTime() + (i + 1) * 4 * H).toISOString(),
          text: fromTech ? tech[(i / 2 + k) % (p.status === "complete" ? 4 : 3)] : client[(i + k) % client.length],
          internal: false,
        });
      }
      if (p.talk > 1) notes.push({ id: `cn${h}-${k}-int`, author: "Équipe AKAB", at: new Date(created.getTime() + H).toISOString(), text: "Note interne : vérifier la garantie avant de commander.", internal: true });
      if (p.question) {
        notes.push({
          id: `cn${h}-${k}-q`,
          author: "Équipe AKAB",
          at: new Date(now - 5 * H).toISOString(),
          text: "Bonjour, pouvez-vous nous indiquer à quelle heure le poste est disponible pour une intervention à distance ?",
          internal: false,
        });
      }
      notes.sort((a, b) => a.at.localeCompare(b.at));
      const n = clientTicketNo++;
      // one ticket also lists the next person as an "other contact" (theirs too)
      if (k === 4 && people.length > 1) setDemoOtherContacts(42000 + n, [people[(k + 1) % people.length].id]);
      store!.push({
        id: 42000 + n,
        number: `T${ymd(created)}.${String(500 + n).padStart(4, "0")}`,
        title,
        description: `${description}\n\n— ${contact.name}`,
        company,
        contact: contact.name,
        contactId: contact.id,
        status: p.status,
        priority: p.priority,
        queue: QUEUES[k % 2],
        source: k % 2 ? "email" : "portal",
        assignee: null,
        slot: p.unassigned ? null : h + k,
        secondarySlots: p.secondary ? [h + k + 1] : [],
        secondary: [],
        createdAt: created.toISOString(),
        dueAt: new Date(now + p.dueH * H).toISOString(),
        updatedAt: notes.at(-1)?.at ?? created.toISOString(),
        hours: p.talk * 0.5,
        notes,
        assetId: null,
      });
    });
  }
}

// ── Contracts per client (Autotask "Contracts"); new clients have none ──
export type Contract = { id: string; name: string; isDefault: boolean; endDate: string | null };
export function demoContracts(companyId: number): Contract[] {
  const c = companyId - 300;
  if (c < 0 || c >= COMPANIES.length) return [];
  return [
    { id: `k-${companyId}-1`, name: "Services gérés — forfait mensuel", isDefault: true, endDate: `${2027 + (c % 2)}-12-31` },
    { id: `k-${companyId}-2`, name: "Banque d'heures 20 h", isDefault: false, endDate: null },
    ...(c % 3 === 0 ? [{ id: `k-${companyId}-3`, name: "Projet — migration Microsoft 365", isDefault: false, endDate: "2027-03-31" }] : []),
  ];
}

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

export function addDemoContact(p: Omit<Contact, "id">, id?: string): Contact {
  const list = allContacts();
  const c: Contact = { ...p, id: id && !list.some((x) => x.id === id) ? id : `c-${p.companyId}-${Date.now()}-${list.length}` };
  list.push(c);
  return c;
}

// ── Devices per client (Autotask "Configuration Items", with RMM data) ──
export type Asset = {
  id: string;
  name: string;
  type: string | null;
  serial: string | null;
  companyId: number;
  contactId: string | null;
  contactName: string | null;
  hostname: string | null;
  ip: string | null;
  os: string | null;
  lastUser: string | null;
  lastSeen: string | null;
  warrantyEnd: string | null;
  /** Device ids in the RMM (Datto RMM fills them in Autotask) */
  rmm: { id: string | null; uid: string | null };
};
let assets: Asset[] | null = null;

function allAssets(): Asset[] {
  assets ??= COMPANIES.flatMap((company, c) => {
    const cid = 300 + c;
    const code = slug(company).replace(/\./g, "").slice(0, 6).toUpperCase();
    const people = demoContacts(cid);
    const year = 2027 + (c % 3);
    return [
      { k: 0, type: "Ordinateur portable", host: `${code}-PORT01`, os: "Windows 11 Pro 24H2", who: people[0] },
      { k: 1, type: "Poste de travail", host: `${code}-PT02`, os: "Windows 11 Pro 24H2", who: people[1] },
      { k: 2, type: "Serveur", host: `${code}-SRV01`, os: "Windows Server 2022", who: undefined },
    ].map(({ k, type, host, os, who }) => ({
      id: `a-${cid}-${k}`,
      name: host,
      type,
      serial: `5CD${cid}${k}X7Q`,
      companyId: cid,
      contactId: who?.id ?? null,
      contactName: who?.name ?? null,
      hostname: host,
      ip: `10.${c}.0.${10 + k}`,
      os,
      lastUser: who ? `${code.toLowerCase()}\\${slug(who.name).split(".")[0]}` : null,
      lastSeen: new Date(Date.now() - (k + 1) * 7 * 60_000).toISOString(),
      warrantyEnd: `${year}-0${(k % 9) + 1}-15`,
      rmm: { id: String(880000 + c * 10 + k), uid: `d3m0-${cid}-${k}-4f1c-9a2e` },
    }));
  });
  return assets;
}
export const demoAssets = (companyId: number) => allAssets().filter((a) => a.companyId === companyId);
