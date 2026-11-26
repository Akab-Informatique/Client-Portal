/**
 * "What's new": one entry per revision put on the server, newest first. The first entry is the latest: it opens by itself at
 * sign-in for whoever has not read it, then never again until a newer one is added here. ADD AN ENTRY WITH EACH PUSH
 * (an id that was already used is never reused: it is what a person's "read" mark points at).
 */
export type WhatsNewSection = { fr: string; en: string; items: { fr: string; en: string }[] };
export type WhatsNewEntry = { id: string; date: string; sections: WhatsNewSection[] };

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    id: "2026-11-27.7",
    date: "2026-11-27",
    sections: [
      {
        fr: "Facturation",
        en: "Invoicing",
        items: [
          { fr: "Une facture qui contient le travail d'un projet le regroupe dans une section « Projet P-… — nom » : la ligne du projet (heures vendues), ses frais, le dépôt déjà facturé, puis le sous-total du projet. Le soutien et les contrats restent hors de la section, et le total ne change pas.", en: "An invoice holding a project's work now groups it in a \"Project P-… — name\" section: the project line (hours sold), its charges, the deposit already invoiced, then the project's subtotal. Support and contracts stay outside the section, and the total does not change." },
          { fr: "Rabais sur la facture (Éléments à facturer) : un montant en $ ou un pourcentage, avec une raison affichée sur la facture, pour corriger une erreur. Il devient une ligne négative répartie entre lignes taxables et non taxables (taxes justes), sur toute la facture ou dans la section d'un projet.", en: "Discount on the invoice (Éléments à facturer): an amount in $ or a percent, with a reason shown on the invoice, to correct an error. It becomes a negative line split between taxable and non-taxable lines (right taxes), on the whole invoice or inside a project's section." },
          { fr: "Projets : un dépôt déjà facturé hors du portail (Info du projet) est retiré de la facture du projet comme un dépôt de soumission, et apparaît dans sa section.", en: "Projects: a deposit already invoiced outside the portal (Project info) comes off the project's invoice like a quote deposit, and shows in its section." },
        ],
      },
    ],
  },
  {
    id: "2026-11-27.6",
    date: "2026-11-27",
    sections: [
      {
        fr: "Projets",
        en: "Projects",
        items: [
          { fr: "Un projet mis à « Terminé » va maintenant dans Approbation pour facturation, comme un projet livré (jamais deux fois). Sans heures vendues, la fenêtre les demande d'abord.", en: "A project set to \"Done\" now goes to Approbation for billing, like a delivered one (never twice). With no hours sold, the window asks for them first." },
        ],
      },
    ],
  },
  {
    id: "2026-11-27.5",
    date: "2026-11-27",
    sections: [
      {
        fr: "Projets",
        en: "Projects",
        items: [
          { fr: "Un projet supprimé ne revient plus au redémarrage : l'archive ne le réimporte plus de lui-même.", en: "A deleted project no longer comes back at restart: the archive does not import it again by itself." },
        ],
      },
      {
        fr: "Soumissions",
        en: "Quotes",
        items: [
          { fr: "Quand une soumission devient un projet, son numéro (P-…) s'écrit dans la soumission : un badge dans l'éditeur et dans la liste ouvre le projet.", en: "When a quote becomes a project, its number (P-…) is written on the quote: a badge in the editor and in the list opens the project." },
        ],
      },
    ],
  },
  {
    id: "2026-11-27.4",
    date: "2026-11-27",
    sections: [
      {
        fr: "Billets",
        en: "Tickets",
        items: [
          { fr: "Dans « Mes billets », « Non assignés » et « À échéance », le filtre de statut « Complété » montre maintenant les billets complétés (il n'en montrait aucun).", en: "In \"My tickets\", \"Unassigned\" and \"Due\", the \"Complete\" status filter now shows the completed tickets (it showed none)." },
          { fr: "Le filtre « En retard » (et « Aujourd'hui ») ne compte plus les billets complétés dans la vue « Tous ».", en: "The \"Overdue\" (and \"Today\") filter no longer counts completed tickets in the \"All\" view." },
        ],
      },
    ],
  },
  {
    id: "2026-11-27.3",
    date: "2026-11-27",
    sections: [
      {
        fr: "Projets livrés",
        en: "Delivered projects",
        items: [
          { fr: "Marquer un projet comme livré demande maintenant les heures vendues s'il n'en a pas (avec le montant que cela donne), pour qu'il arrive toujours dans Approbation. Un projet livré sans ligne propose d'inscrire les heures et « Envoyer à l'approbation », et dit où en est sa ligne avec un lien « Voir dans Approbation ».", en: "Marking a project delivered now asks for the hours sold when it has none (with the amount that comes to), so it always reaches Approbation. A delivered project with no line offers to enter the hours and \"Send to approval\", and says where its line stands with a \"See in Approbation\" link." },
          { fr: "Fermer un projet dont le minuteur a moins de 3 minutes jette le temps sans rien demander, comme un billet.", en: "Closing a project whose timer is under 3 minutes throws the time away without asking, like a ticket." },
          { fr: "Dans les frais d'un projet, le bouton « Étiquette » est maintenant bien visible sur chaque frais.", en: "In a project's charges, the \"Label\" button is now clearly visible on each charge." },
        ],
      },
    ],
  },
  {
    id: "2026-11-27.2",
    date: "2026-11-27",
    sections: [
      {
        fr: "Projets livrés",
        en: "Delivered projects",
        items: [
          { fr: "Pour ceux qui vérifient et facturent, les projets livrés restent en haut de la liste des billets, avec « Livré — à facturer » et la date, jusqu'à leur fermeture. Un compteur « n livrés » est sur le bouton Tous les projets, et le projet ouvert propose « Envoyer à l'approbation » et « Fermer le projet (facturé) ».", en: "For the people who check and bill, delivered projects stay at the top of the tickets list, marked \"Delivered — to bill\" with the date, until they are closed. An \"n delivered\" count sits on the All projects button, and the opened project offers \"Send to approval\" and \"Close the project (billed)\"." },
        ],
      },
      {
        fr: "Facturation des projets",
        en: "Project billing",
        items: [
          { fr: "Un projet se facture toujours sur les heures vendues, jamais sur les heures travaillées : plus aucune ligne par entrée de temps. « Heures vendues » est obligatoire (sauf sous une banque d'heures prépayée), et le client ne voit jamais les heures travaillées.", en: "A project is always billed on the hours sold, never the hours worked: no more line per time entry. \"Hours sold\" is required (except under a prepaid hours bank), and the client never sees the hours worked." },
        ],
      },
    ],
  },
  {
    id: "2026-11-27.1",
    date: "2026-11-27",
    sections: [
      {
        fr: "Banques d'heures prépayées",
        en: "Prepaid hours banks",
        items: [
          { fr: "On peut vendre une banque d'heures dans une soumission (ligne « Banque d'heures », créée quand la soumission est acceptée), dans Factures › Éléments à facturer ou dans l'onglet Contrats du client. Elle s'ajoute au client et le temps travaillé s'en déduit jusqu'à ce qu'il n'en reste plus.", en: "An hours bank can be sold in a quote (a \"Hours bank\" line, made when the quote is accepted), in Invoices › Items to invoice or in the client's Contracts tab. It is added to the client and the time worked is taken off it until none is left." },
          { fr: "Une banque peut être liée à un billet ou à un projet précis : un client peut avoir plusieurs banques, une par projet. Le reste d'heures s'affiche dans le choix du contrat du billet et du projet.", en: "A bank can be tied to one ticket or one project: a client can have several banks, one per project. The hours left show in the ticket's and the project's contract choice." },
        ],
      },
      {
        fr: "Billets",
        en: "Tickets",
        items: [
          { fr: "Fermer un billet dont le minuteur a moins de 3 minutes jette le temps sans rien demander.", en: "Closing a ticket whose timer is under 3 minutes throws the time away without asking." },
        ],
      },
    ],
  },
  {
    id: "2026-11-26.2",
    date: "2026-11-26",
    sections: [
      {
        fr: "Utilisation sur téléphone",
        en: "Using it on a phone",
        items: [
          { fr: "Le portail a été vérifié page par page sur un téléphone : les pages plus larges que l'écran s'ajustent maintenant (fenêtres de billet et de projet, Ma journée, Inventaire, RH, Rencontre hebdomadaire, Paiements fournisseurs, Ventes).", en: "The portal was checked page by page on a phone: pages that were wider than the screen now fit (ticket and project windows, Ma journée, Inventory, HR, Weekly meeting, Vendor payments, Sales)." },
        ],
      },
      {
        fr: "Facturation",
        en: "Billing",
        items: [
          { fr: "Approbation sépare les clients facturés en fin de mois (le 30 pour la période du 1er au 30) de ceux facturés en début de mois (le 1er pour le mois à venir), avec un filtre. Le moment se règle dans les paramètres de facturation du client, ou d'un clic sur l'étiquette du client dans Approbation.", en: "Approbation separates the clients billed at the end of the month (on the 30th for the 1st–30th) from those billed at the start (on the 1st for the month ahead), with a filter. The timing is set in the client's invoice settings, or with one click on the client's badge in Approbation." },
        ],
      },
      {
        fr: "Projets",
        en: "Projects",
        items: [
          { fr: "« Marquer comme livré » avise maintenant aussi la personne qui clique quand c'est elle qui vérifie et facture, et envoie le projet dans Approbation pour qu'il soit facturé. « Remettre en cours » retire la ligne si elle n'a pas encore été approuvée.", en: "\"Mark as delivered\" now also tells the person who clicks when they are the one who checks and bills, and sends the project to Approbation to be billed. \"Back in progress\" removes the line if it was not approved yet." },
        ],
      },
    ],
  },
  {
    id: "2026-11-26.1",
    date: "2026-11-26",
    sections: [
      {
        fr: "Projets",
        en: "Projects",
        items: [
          { fr: "Nouveau bouton « Tous les projets » parmi les boutons rapides des billets : il affiche tous les projets ouverts, peu importe le responsable ou le client, sans les billets, avec des filtres Ouverts, Livrés et Terminés.", en: "New \"All projects\" button among the ticket quick buttons: it shows every open project, whoever leads it or whichever client, without tickets, with Open, Delivered and Finished filters." },
          { fr: "Le bouton + de la barre du haut propose maintenant « Nouveau projet ».", en: "The + button of the top bar now offers \"New project\"." },
          { fr: "Dans un projet : la cloche « Notifier un technicien » (cloche, courriel, texto, Teams) et, sur une note interne, le choix des collègues à aviser, comme sur un billet.", en: "In a project: the \"Notify a technician\" bell (bell, email, text, Teams) and, on an internal note, a choice of colleagues to tell, like on a ticket." },
          { fr: "Nouveau bouton « Marquer comme livré » : le projet passe à « Livré — à facturer » et les personnes qui vérifient et facturent (réglage par un gestionnaire, sinon les administrateurs principaux) reçoivent la cloche et un courriel.", en: "New \"Mark as delivered\" button: the project becomes \"Delivered — to bill\" and the people who check and bill (set by a manager, otherwise the master administrators) get the bell and an email." },
          { fr: "Un projet qui a des heures vendues est facturé selon ces heures (jamais selon les heures travaillées) et ses entrées de temps ne sont pas facturées une à une. Quand les heures travaillées dépassent les heures vendues, les mêmes personnes sont averties une fois, et la jauge indique le dépassement.", en: "A project with hours sold is billed by those hours (never the hours worked) and its time entries are not billed one by one. When the hours worked pass the hours sold, the same people are told once, and the gauge shows the overrun." },
        ],
      },
    ],
  },
  {
    id: "2026-11-23.4",
    date: "2026-11-23",
    sections: [
      {
        fr: "Billets",
        en: "Tickets",
        items: [
          { fr: "Nouvel onglet « Tâches » après Activité, Textos et Pièces jointes : la liste de contrôle du billet y est, et l'onglet montre les tâches restantes sur le total (1/2 = une tâche reste à faire, 0/2 = tout est fait).", en: "New \"Tasks\" tab after Activity, Texts and Attachments: the ticket's checklist lives there, and the tab shows tasks left out of the total (1/2 = one task left, 0/2 = all done)." },
        ],
      },
    ],
  },
  {
    id: "2026-11-23.3",
    date: "2026-11-23",
    sections: [
      {
        fr: "Vente",
        en: "Sales",
        items: [
          { fr: "Nouvelle section Opportunités (menu Vente) : un technicien signale une demande de vente pour le technicien aux ventes, avec le client, le contact, la description, et si une soumission suffit ou s'il faut appeler le client. Le bouton « Créer une opportunité » est dans la fenêtre du billet, qui reste liée à l'opportunité. On choisit par courriel qui informer; un badge dans le menu et une étoile près de Vente indiquent les nouvelles.", en: "New Opportunities section (Sales menu): a technician flags a sales request for the sales technician, with the client, the contact, the description, and whether a quote is enough or the client must be called. The \"Create an opportunity\" button is in the ticket window, and the ticket stays linked. You pick who is told by email; a badge in the menu and a star near Sales show the new ones." },
          { fr: "Depuis une opportunité on crée une soumission (liée automatiquement) ou on lie un contrat, un frais ou un projet. Une opportunité gagnée, perdue ou annulée est archivée, jamais supprimée, et l'onglet Rapport compte ce qu'on a gagné, perdu et ce que ça a rapporté.", en: "From an opportunity you create a quote (linked automatically) or link a contract, a charge or a project. A won, lost or canceled opportunity is archived, never deleted, and the Report tab counts what was won, lost and what it brought in." },
        ],
      },
    ],
  },
  {
    id: "2026-11-23.2",
    date: "2026-11-23",
    sections: [
      {
        fr: "Billets",
        en: "Tickets",
        items: [
          { fr: "Nouveau bouton « Étiquette d'équipement » dans le billet : imprime le nombre d'étiquettes voulu (Équipement 1/2, 2/2…) avec le numéro du billet, son titre et le client, à coller sur l'équipement du client.", en: "New \"Equipment label\" button in the ticket: prints as many labels as you want (Equipment 1/2, 2/2…) with the ticket number, title and client, to stick on the client's equipment." },
        ],
      },
    ],
  },
  {
    id: "2026-11-23.1",
    date: "2026-11-23",
    sections: [
      {
        fr: "Courriel",
        en: "Email",
        items: [
          { fr: "Le courriel « Billet reçu » (flux de travail « Réponse à un nouveau billet », toujours désactivé jusqu'à ce que vous l'activiez) dit maintenant qu'un technicien sera assigné sous peu, donne le numéro du soutien pour une urgence (514-834-3344, option 1) et invite à suivre la demande sur le portail ou à nous contacter pour obtenir l'accès. Le texte reste modifiable dans Admin › Courriel.", en: "The \"Ticket received\" email (the \"Reply to a new ticket\" workflow, still off until you switch it on) now says a technician will be assigned shortly, gives the support number for an emergency (514-834-3344, option 1) and invites people to follow the request on the portal or contact us for access. The text can still be edited in Admin › Email." },
        ],
      },
    ],
  },
  {
    id: "2026-11-22.1",
    date: "2026-11-22",
    sections: [
      {
        fr: "Billets",
        en: "Tickets",
        items: [
          { fr: "Une réponse du client par courriel ou par texto sur un billet fermé rouvre maintenant le billet (statut « Nécessite attention »), comme une réponse faite dans le portail. Un billet fusionné reste fermé.", en: "A client's reply by email or text on a closed ticket now reopens it (status \"Needs attention\"), like a reply made in the portal. A merged ticket stays closed." },
        ],
      },
    ],
  },
  {
    id: "2026-11-19.2",
    date: "2026-11-19",
    sections: [
      {
        fr: "Vault pour les clients",
        en: "Vault for clients",
        items: [
          { fr: "Le portail client a maintenant une page Vault (Opérations) : le client s'y connecte avec son propre compte Vault. Le droit « Ouvrir le coffre-fort » est donné à tous les rôles client et se retire par rôle.", en: "The client portal now has a Vault page (Operations): the client signs in with their own Vault account. The \"Open the vault\" right is given to every client role and can be removed per role." },
        ],
      },
    ],
  },
  {
    id: "2026-11-19.1",
    date: "2026-11-19",
    sections: [
      {
        fr: "Mes outils TI",
        en: "My IT tools",
        items: [
          { fr: "Nouvelle page Vault : le coffre-fort vault.akab.ca s'affiche dans le portail. À la première visite, la connexion Microsoft 365 se fait dans un nouvel onglet.", en: "New Vault page: the vault.akab.ca password vault shows inside the portal. On the first visit, the Microsoft 365 sign-in is done in a new tab." },
        ],
      },
    ],
  },
  {
    id: "2026-11-18.1",
    date: "2026-11-18",
    sections: [
      {
        fr: "Dashboard TV",
        en: "Dashboard TV",
        items: [
          { fr: "Nouvel écran technique pour la télé du département : billets ouverts, en retard et non assignés, équipe, projets en cours, parc Datto, réseau UniFi et tendance de la semaine. Il a son propre lien et sa propre clé (Dashboard TV, onglet Écran technique), et ne montre ni adresse, ni courriel, ni note, ni montant.", en: "New technical screen for the department's TV: open, overdue and unassigned tickets, team, projects in progress, Datto devices, UniFi network and the week's trend. It has its own link and key (Dashboard TV, Technical screen tab), and shows no address, email, note or amount of money." },
        ],
      },
    ],
  },
  {
    id: "2026-11-17.15",
    date: "2026-11-17",
    sections: [
      {
        fr: "Intégrations",
        en: "Integrations",
        items: [
          { fr: "Datto RMM et UniFi : le bouton Tester enregistre d'abord la clé tapée, puis la teste (avant, il testait l'ancienne clé enregistrée).", en: "Datto RMM and UniFi: the Test button first saves the key typed, then tests it (it used to test the key saved before)." },
        ],
      },
    ],
  },
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
