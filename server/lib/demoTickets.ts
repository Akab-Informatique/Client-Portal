/**
 * Sample tickets to design and try the Tickets screens before they are wired
 * to Autotask. Same shape as what the Autotask connector will return, so the
 * UI does not change when the data becomes real. Kept in memory (lost on restart).
 */
export type TicketStatus = "new" | "inProgress" | "waitingCustomer" | "waitingVendor" | "scheduled" | "complete";
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
  status: TicketStatus;
  priority: TicketPriority;
  queue: string;
  source: "email" | "phone" | "portal" | "monitoring";
  assignee: Person | null;
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

let store: Ticket[] | null = null;
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

/** All sample tickets; assignees are the portal's technicians (round robin). */
export function demoTickets(staff: Person[]): Ticket[] {
  if (store) return store;
  const r = rng(42);
  const now = Date.now();
  const H = 3600_000;
  const statuses: TicketStatus[] = ["new", "inProgress", "inProgress", "waitingCustomer", "waitingVendor", "scheduled", "complete"];
  const priorities: TicketPriority[] = ["critical", "high", "high", "medium", "medium", "medium", "low", "low"];
  store = Array.from({ length: 36 }, (_, i) => {
    const [title, description] = SUBJECTS[i % SUBJECTS.length];
    const created = new Date(now - Math.floor(r() * 12 * 24) * H);
    const status = i < 5 ? "new" : pick(r, statuses);
    const priority = /Alerte|Hameçonnage|Sauvegarde|Courriels/.test(title) ? (r() > 0.5 ? "critical" : "high") : pick(r, priorities);
    const due = new Date(now + (Math.floor(r() * 10 * 24) - 3 * 24) * H);
    const unassigned = status === "new" && r() > 0.3;
    const assignee = unassigned || staff.length === 0 ? null : staff[i % staff.length];
    const company = { id: 300 + (i % COMPANIES.length), name: COMPANIES[i % COMPANIES.length] };
    const contact = CONTACTS[(i * 3) % CONTACTS.length];
    const notes: Note[] = [];
    const n = Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      notes.push({
        id: `n${i}-${k}`,
        author: k % 2 === 0 && assignee ? assignee.name : contact,
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
      status,
      priority,
      queue: /Projet|Migration|Remplacement|Mise à jour/.test(title) ? "Projets" : /VPN|pare-feu|Wi-Fi|Hameçonnage/.test(title) ? "Réseau et sécurité" : pick(r, QUEUES.slice(0, 2)),
      source: /Alerte|Sauvegarde/.test(title) ? "monitoring" : pick(r, ["email", "phone", "portal"] as const),
      assignee,
      createdAt: created.toISOString(),
      dueAt: due.toISOString(),
      updatedAt: (notes.at(-1)?.at ?? created.toISOString()),
      hours: Math.round(r() * 60) / 10,
      notes,
    } satisfies Ticket;
  });
  return store;
}

export function addDemoTicket(t: Omit<Ticket, "id" | "number" | "createdAt" | "updatedAt" | "hours" | "notes">): Ticket {
  const created = new Date();
  const ticket: Ticket = {
    ...t,
    id: nextId++,
    number: `T${ymd(created)}.${String(nextId % 10000).padStart(4, "0")}`,
    createdAt: created.toISOString(),
    updatedAt: created.toISOString(),
    hours: 0,
    notes: [],
  };
  store?.unshift(ticket);
  return ticket;
}

export const demoCompanies = () => COMPANIES.map((name, i) => ({ id: 300 + i, name }));
