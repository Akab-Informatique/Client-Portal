/**
 * "What's new": one entry per revision put on the server, newest first. The first entry is the latest: it opens by itself at
 * sign-in for whoever has not read it, then never again until a newer one is added here. ADD AN ENTRY WITH EACH PUSH
 * (an id that was already used is never reused: it is what a person's "read" mark points at).
 */
export type WhatsNewSection = { fr: string; en: string; items: { fr: string; en: string }[] };
export type WhatsNewEntry = { id: string; date: string; sections: WhatsNewSection[] };

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    id: "2026-11-13.2",
    date: "2026-11-13",
    sections: [
      {
        fr: "Rappel d'inactivité",
        en: "Inactivity reminder",
        items: [
          { fr: "Un billet, une tâche, un « à faire » ou un projet sans aucune activité clignote dans les listes après 3 jours ouvrables (fins de semaine exclues).", en: "A ticket, task, to-do or project with no activity flashes in the lists after 3 working days (weekends excluded)." },
          { fr: "Si l'échéance est à plus de 3 semaines, le délai passe automatiquement à 6 jours ouvrables.", en: "When the due day is more than 3 weeks away, the delay automatically becomes 6 working days." },
          { fr: "Ouvrir l'élément ou cliquer « Remettre à zéro » relance le compte ; le délai peut aussi être choisi sur l'élément.", en: "Opening the item or clicking \"Reset\" starts the count again; the delay can also be set on the item." },
        ],
      },
      {
        fr: "Une seule date : l'échéance",
        en: "One date: the due day",
        items: [
          { fr: "La date de début et le checkpoint sont retirés partout ; il reste l'échéance (sans heure).", en: "The start date and checkpoint are gone everywhere; only the due day remains (no time)." },
          { fr: "Le tri par défaut des billets, tâches, « à faire » et projets est l'échéance.", en: "The default sort of tickets, tasks, to-dos and projects is the due day." },
          { fr: "Ma journée ne se remplit plus seule : seulement ce que vous y ajoutez.", en: "Ma journée no longer fills itself: only what you add." },
        ],
      },
    ],
  },
  {
    id: "2026-11-13.1",
    date: "2026-11-13",
    sections: [
      {
        fr: "Projets : facturation et import",
        en: "Projects: billing and import",
        items: [
          { fr: "Approbation : le temps des projets s'approuve par mois, puis par projet (fini les jalons).", en: "Approval: project time is approved by month, then by project (no more milestones)." },
          { fr: "Facturation d'un projet : à l'heure, sous contrat, taux spécial, prix fixe ou banque d'heures.", en: "Project billing: hourly, under a contract, special rate, fixed price or bank of hours." },
          { fr: "Fichiers joints aux notes et aux réponses, comme sur un billet.", en: "Files attached to notes and replies, like on a ticket." },
          { fr: "Importer l'archive des anciens projets dans le nouveau format.", en: "Import the old archive projects into the new format." },
          { fr: "Boutons « Transformer en projet » (billet) et « Créer un projet » (soumission).", en: "\"Turn into a project\" (ticket) and \"Create a project\" (quote) buttons." },
        ],
      },
    ],
  },
  {
    id: "2026-11-12.1",
    date: "2026-11-12",
    sections: [
      {
        fr: "Nouveau format des projets",
        en: "New project format",
        items: [
          { fr: "Les projets sont dans la liste des billets (P-###), en violet, avec un filtre Tout / Billets / Projets.", en: "Projects are in the tickets list (P-###), in violet, with an All / Tickets / Projects filter." },
          { fr: "Liste de tâches assignées, notes qui ciblent des tâches, minuteur du projet et entrées de temps.", en: "Assigned task list, notes that tag tasks, project timer and time entries." },
        ],
      },
    ],
  },
];
