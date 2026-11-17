/**
 * "What's new": one entry per revision put on the server, newest first. The first entry is the latest: it opens by itself at
 * sign-in for whoever has not read it, then never again until a newer one is added here. ADD AN ENTRY WITH EACH PUSH
 * (an id that was already used is never reused: it is what a person's "read" mark points at).
 */
export type WhatsNewSection = { fr: string; en: string; items: { fr: string; en: string }[] };
export type WhatsNewEntry = { id: string; date: string; sections: WhatsNewSection[] };

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    id: "2026-11-17.14",
    date: "2026-11-17",
    sections: [
      {
        fr: "Mes outils TI",
        en: "My IT tools",
        items: [
          { fr: "L'ancien réglage « Liens vers le RMM » est retiré : les boutons Contrôle à distance et Ouvrir dans Datto d'un billet viennent maintenant de Datto RMM.", en: "The old “RMM links” setting is removed: a ticket's Remote control and Open in Datto buttons now come from Datto RMM." },
          { fr: "Console UniFi : le firmware des consoles est mieux lu.", en: "UniFi console: the consoles' firmware is read better." },
        ],
      },
    ],
  },
  {
    id: "2026-11-17.13",
    date: "2026-11-17",
    sections: [
      {
        fr: "Mes outils TI",
        en: "My IT tools",
        items: [
          { fr: "La page Appareils (le parc Datto RMM de tous les clients) est maintenant dans Mes outils TI, à côté de la Console UniFi.", en: "The Devices page (every client's Datto RMM fleet) is now under My IT tools, next to the UniFi console." },
          { fr: "Nouvelle section « Mes outils TI » dans le menu avec la Console UniFi : consoles, sites et appareils UniFi (Ubiquiti) en lecture seule, ce qui est hors ligne ou à mettre à jour en premier.", en: "New \"My IT tools\" section in the menu with the UniFi console: UniFi (Ubiquiti) consoles, sites and devices, read only, with what is offline or needs an update first." },
          { fr: "Un administrateur branche la clé d'API dans Admin › Intégrations › UniFi.", en: "An administrator connects the API key in Admin › Integrations › UniFi." },
        ],
      },
    ],
  },
  {
    id: "2026-11-17.12",
    date: "2026-11-17",
    sections: [
      {
        fr: "Menu",
        en: "Menu",
        items: [
          { fr: "Nouvelle section Marketing dans le menu de gauche : l'Infolettre y est maintenant (elle n'est plus dans Gestion). L'entrée « Marketing » qui attendait dans Vente est retirée.", en: "New Marketing section in the left menu: the Newsletter is there now (no longer under Management). The placeholder Marketing entry under Sales is gone." },
        ],
      },
    ],
  },
  {
    id: "2026-11-17.11",
    date: "2026-11-17",
    sections: [
      {
        fr: "Billets",
        en: "Tickets",
        items: [
          { fr: "Fermer un billet avec un minuteur ouvre d'abord une petite fenêtre à 3 choix, comme pour un projet : saisir le temps maintenant (la grande fenêtre s'ouvre alors), plus tard (le billet va dans le tiroir et le minuteur continue) ou fermer sans temps. La fenêtre de saisie du temps a aussi un bouton pour la réduire dans le tiroir.", en: "Closing a ticket with a timer now first opens a small 3-choice window, like a project: enter the time now (the big window then opens), later (the ticket goes to the drawer and the timer keeps going) or close without time. The time entry window also has a button to minimize it to the drawer." },
        ],
      },
    ],
  },
  {
    id: "2026-11-17.10",
    date: "2026-11-17",
    sections: [
      {
        fr: "Billets",
        en: "Tickets",
        items: [
          { fr: "Dans la liste des billets et dans Ma journée, chaque échéance a son propre fond légèrement différent (en alternance) : on voit tout de suite où la date change. Les projets suivent le même fond que les billets (en gardant leur barre et leur numéro mauves), et un billet long terme a son titre en bleu.", en: "In the tickets list and in My day, each due day has its own slightly different background (alternating): you see right away where the date changes. Projects follow the same background as tickets (keeping their purple bar and number), and a long term ticket has its title in blue." },
        ],
      },
    ],
  },
  {
    id: "2026-11-17.9",
    date: "2026-11-17",
    sections: [
      {
        fr: "Billets",
        en: "Tickets",
        items: [
          { fr: "Nouveau type de billet : court terme (jaune, comme avant) ou long terme (orange). Il se choisit à la création et se change en tout temps dans le billet; le numéro du billet prend la couleur du type dans les listes, la vue compacte et Ma journée.", en: "New ticket type: short term (yellow, as before) or long term (orange). Pick it when creating and change it any time in the ticket; the ticket number takes the type's colour in the lists, the compact view and My day." },
        ],
      },
    ],
  },
  {
    id: "2026-11-17.8",
    date: "2026-11-17",
    sections: [
      {
        fr: "Projets",
        en: "Projects",
        items: [
          { fr: "Le statut d'un projet est maintenant : Planification, En cours, En attente du client, En attente du fournisseur ou Terminé. Il s'affiche sur chaque projet dans Comptabilité › Approbation (onglet Projets).", en: "A project's status is now: Planning, In progress, Waiting on customer, Waiting on vendor or Done. It shows on each project in Accounting › Approvals (Projects tab)." },
          { fr: "Corrigé : la fenêtre « Quelle entrée de temps ? » débordait avec de longues notes et cachait le bouton de confirmation.", en: "Fixed: the “Which time entry?” window overflowed with long notes and hid the confirm button." },
        ],
      },
    ],
  },
  {
    id: "2026-11-17.7",
    date: "2026-11-17",
    sections: [
      {
        fr: "Ma journée",
        en: "Ma journée",
        items: [
          { fr: "Ce que tu retires de ta journée disparaît du plan (au lieu d'être grisé). Un bloc est grisé seulement quand son heure est passée, qu'il est terminé ou que tu le mets de côté. Deux boutons au survol d'un bloc : ✓ Terminé (demande le temps final) et ⏭ Continuer un autre jour (grise l'élément pour la journée et propose de mettre à jour l'information ou d'entrer du temps).", en: "What you remove from your day disappears from the plan (instead of being greyed). A block is greyed only when its time has passed, it is finished, or you set it aside. Two buttons on hover: ✓ Done (asks for the final time) and ⏭ Continue another day (greys the item for the day and offers to update the information or enter time)." },
          { fr: "Corrigé : un élément déplacé à la main dans un plan fait par l'IA apparaissait en double, ce qui empêchait aussi de chevaucher deux éléments. Ils peuvent maintenant se chevaucher côte à côte.", en: "Fixed: an item dragged by hand in an AI plan showed up twice, which also stopped two items from overlapping. They can now overlap side by side." },
        ],
      },
    ],
  },
  {
    id: "2026-11-17.6",
    date: "2026-11-17",
    sections: [
      {
        fr: "Clients et contrats",
        en: "Clients and contracts",
        items: [{ fr: "Chaque nouveau client reçoit deux contrats à taux horaire, sans date de fin : « Contrat de soutien » (100 $/h, contrat de soutien par défaut) et « Application development » (150 $/h). Admin › Rôles et usagers › Clients : le bouton « Créer les contrats de base » les crée pour les clients actifs existants (le contrat de soutien est créé inactif si le client a déjà un contrat par défaut).", en: "Every new client gets two hourly contracts with no end date: \"Contrat de soutien\" (100 $/h, the default support contract) and \"Application development\" (150 $/h). Admin › Roles and users › Clients: the \"Create the base contracts\" button makes them for the existing active clients (the support contract is made inactive when the client already has a default)." }],
      },
    ],
  },
  {
    id: "2026-11-17.5",
    date: "2026-11-17",
    sections: [
      {
        fr: "Ma journée",
        en: "Ma journée",
        items: [{ fr: "Le plan fait par l'IA laisse 5 minutes entre les éléments et un trou de 15 minutes toutes les 2 heures pour les imprévus (seulement si la journée n'en souffre pas). « Remplir avec l'IA » garde environ 12 % du temps libre en réserve.", en: "The AI plan leaves 5 minutes between items and a 15-minute gap every 2 hours for the unexpected (only when the day does not suffer for it). \"Fill with AI\" keeps about 12% of the free time in reserve." }],
      },
    ],
  },
  {
    id: "2026-11-17.4",
    date: "2026-11-17",
    sections: [
      {
        fr: "Appareils",
        en: "Devices",
        items: [
          { fr: "La page Appareils du menu est active : tous les appareils de tous les clients (Datto RMM), groupés par client (on les ouvre ou on les réduit), avec le dernier utilisateur, ce qu'il faut faire en premier (correctifs, redémarrage, antivirus, fin de support, hors ligne, garantie), les sources (D = Datto, A = agent AKAB à venir) et une fiche à droite avec le contrôle à distance. Le terminal viendra avec l'agent AKAB.", en: "The Devices page of the menu is live: every device of every client (Datto RMM), grouped by client (open or fold them), with the last user, what to do first (patches, reboot, antivirus, end of support, offline, warranty), the sources (D = Datto, A = AKAB agent to come) and a side panel with remote control. The terminal will come with the AKAB agent." },
        ],
      },
    ],
  },
  {
    id: "2026-11-17.3",
    date: "2026-11-17",
    sections: [
      {
        fr: "Ma journée",
        en: "My day",
        items: [
          { fr: "Plan de la journée : un bouton « Remplir avec l'IA » analyse tous vos billets, puis vos tâches de projet, vos projets et vos tâches internes (dans cet ordre) et remplit la journée de 8 h à 17 h autour de vos événements Outlook, avec des sprints : un long travail n'avance que d'une partie aujourd'hui, pour que tout progresse et que rien ne reste pour la dernière minute. Vous pouvez ensuite tout ajuster.", en: "Daily plan: a \"Fill with AI\" button looks at all your tickets, then your project tasks, projects and internal tasks (in that order) and fills the day from 8 to 5 around your Outlook events, in sprints: a long job only advances by a part today, so everything moves and nothing is left for the last minute. You can then adjust everything." },
          { fr: "Un bouton « Vider la journée » retire tout ce qui est planifié (les événements Outlook et les plages bloquées restent).", en: "A \"Clear the day\" button removes everything planned (Outlook events and blocked slots stay)." },
          { fr: "La grille montre de 6 h à 19 h. Le travail est planifié entre 8 h et 17 h, mais un bloc glissé à la main reste là où vous le déposez, même avant 8 h, après 17 h ou sur un événement. Les blocs qui se chevauchent sont affichés côte à côte.", en: "The grid shows 6 am to 7 pm. Work is planned between 8 and 5, but a block you drag stays where you drop it, even before 8, after 5 or over an event. Overlapping blocks are shown side by side." },
        ],
      },
    ],
  },
  {
    id: "2026-11-17.2",
    date: "2026-11-17",
    sections: [
      {
        fr: "Projets",
        en: "Projects",
        items: [
          { fr: "Le minuteur d'un projet démarre tout seul à l'ouverture et s'affiche en haut de la fenêtre, comme celui d'un billet, avec pause / lecture et un bouton « Saisir le temps ». Le même bouton est dans le tiroir des éléments minimisés, où un minuteur en marche reste visible. L'entrée de temps reprend automatiquement le temps du minuteur.", en: "A project's timer starts by itself when it is opened and shows at the top of the window, like a ticket's, with pause / play and an \"Enter time\" button. The same button is in the drawer of minimized items, where a running timer stays visible. The time entry takes the timer's time automatically." },
          { fr: "Fermer un projet dont le minuteur tourne demande quoi faire : saisir le temps, le jeter, ou attendre (le projet est réduit dans le tiroir et le minuteur continue).", en: "Closing a project whose timer is running asks what to do: enter the time, discard it, or wait (the project is minimized to the drawer and the timer keeps going)." },
        ],
      },
    ],
  },
  {
    id: "2026-11-17.1",
    date: "2026-11-17",
    sections: [
      {
        fr: "Projets",
        en: "Projects",
        items: [
          { fr: "Dans un projet, la tuile Frais est active : on y met le matériel vendu (article de l'inventaire ou frais ponctuel), avec rabais, coût, étiquette et suivi Commandé / Reçu au bureau. Un frais facturable va tout de suite à l'approbation, pour le client du projet. Un projet fait depuis une soumission reçoit ses produits comme frais.", en: "In a project, the Charges tile now works: put the equipment sold there (an inventory item or a one-time charge), with rebate, cost, label and Ordered / Received at the office tracking. A billable charge goes straight to approval for the project's client. A project made from a quote gets its products as charges." },
          { fr: "Les tâches faites d'un projet sont nettement plus foncées (ligne presque noire, texte gris barré) : les tâches ouvertes ressortent.", en: "A project's finished tasks are clearly darker (near-black row, grey struck-out text), so the open ones stand out." },
        ],
      },
    ],
  },
  {
    id: "2026-11-16.4",
    date: "2026-11-16",
    sections: [
      {
        fr: "Dashboard TV",
        en: "Dashboard TV",
        items: [
          { fr: "La télé du hall protège son écran : l'image se décale de quelques pixels toutes les 2 minutes, la luminosité est réglable et l'écran se met au repos hors des heures d'ouverture (horloge pâle qui change de place). Réglages dans Dashboard TV › Gérer › Protection de l'écran.", en: "The lobby TV protects its panel: the picture shifts a few pixels every 2 minutes, the brightness can be set and the screen rests outside opening hours (a dim clock that moves around). Settings in Dashboard TV › Manage › Screen protection." },
        ],
      },
    ],
  },
  {
    id: "2026-11-16.3",
    date: "2026-11-16",
    sections: [
      {
        fr: "Contrats",
        en: "Contracts",
        items: [{ fr: "Une ligne de contrat peut recevoir ou perdre des unités à partir d'un jour : une unité ajoutée en milieu de mois est facturée au prorata (à approuver dans Approbation), une unité retirée crédite ce qui était déjà approuvé.", en: "A contract line can gain or lose units from a given day: a unit added mid-month is billed prorated (queued in Approbation), a unit taken off credits what was already approved." }],
      },
    ],
  },
  {
    id: "2026-11-16.2",
    date: "2026-11-16",
    sections: [
      {
        fr: "Projets",
        en: "Projects",
        items: [{ fr: "La fenêtre d'un projet a un bouton Réduire (en haut) : le projet reste dans le tiroir, comme un billet, et se rouvre en un clic.", en: "A project window has a Minimize button (top): the project waits in the drawer like a ticket and reopens in one click." }],
      },
    ],
  },
  {
    id: "2026-11-16.1",
    date: "2026-11-16",
    sections: [
      {
        fr: "Rappel d'inactivité",
        en: "Inactivity reminder",
        items: [
          { fr: "Ma journée et la liste des billets : un projet a maintenant le même menu qu'un billet (le trait à gauche) : ajouter à ma journée, ouvrir.", en: "Ma journée and the tickets list: a project now has the same menu as a ticket (the line on the left): add to my day, open." },
          { fr: "Admin › Billets : un bouton remet à zéro tous les rappels d'un coup, sans ouvrir chaque billet, tâche ou projet.", en: "Admin › Tickets: one button resets every reminder at once, without opening each ticket, task or project." },
        ],
      },
    ],
  },
  {
    id: "2026-11-15.1",
    date: "2026-11-15",
    sections: [
      {
        fr: "Tri des projets par tâche",
        en: "Projects sorted by task",
        items: [
          { fr: "Un projet est classé selon l'échéance de sa tâche la plus proche (sinon son échéance). Un projet sans tâche clignote, affiche « Aucune tâche » et avertit à l'ouverture.", en: "A project is sorted by the due date of its nearest task (else its own). A project with no task flashes, says \"No task\" and warns when opened." },
        ],
      },
    ],
  },
  {
    id: "2026-11-13.4",
    date: "2026-11-13",
    sections: [
      {
        fr: "Projets et billets mélangés; démarrage d'un projet",
        en: "Mixed projects and tickets; starting a project",
        items: [
          { fr: "Les projets et les billets sont mélangés et triés par échéance dans la liste des billets et dans Ma journée. Boutons Tout / Billets / Projets et Regrouper pour les séparer.", en: "Projects and tickets are mixed and sorted by due date in the tickets list and in Ma journée. Use All / Tickets / Projects and Group to keep them apart." },
          { fr: "Un nouveau projet (à la main, depuis une soumission ou un billet) ouvre une fenêtre : responsable, équipe, courte description et notes. Le tout va dans les notes du projet et le responsable est avisé par courriel et par la cloche.", en: "A new project (by hand, from a quote or from a ticket) opens a pop-up: lead, team, short description and notes. They go in the project's notes and the lead is told by email and by the bell." },
        ],
      },
    ],
  },
  {
    id: "2026-11-13.3",
    date: "2026-11-13",
    sections: [
      {
        fr: "Projets de l'archive",
        en: "Archive projects",
        items: [
          { fr: "Les anciens projets sont maintenant des projets du nouveau format : ils apparaissent dans la liste des billets (P-###), avec leurs tâches, notes, fichiers, temps et facturation.", en: "The old projects are now projects of the new format: they show in the tickets list (P-###), with their tasks, notes, files, time and billing." },
          { fr: "« Archive projets » n'est plus dans le menu.", en: "\"Archive projets\" is no longer in the menu." },
        ],
      },
    ],
  },
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
