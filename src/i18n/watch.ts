/** Texts of the "no activity" reminder and of "What's new". Keys under `watch` and `whatsNew`. */
export const fr = {
  watch: {
    title: "Rappel d'inactivité",
    quiet: "Aucune activité depuis {{count}} jours ouvrables",
    every: "Rappel après {{count}} jours ouvrables sans activité",
    days: "Jours ouvrables avant le rappel",
    daysUnit: "j. ouvrables",
    daysHint: "Vide = le délai habituel (3 jours ouvrables, 6 si l'échéance est à plus de 3 semaines)",
    reset: "Remettre à zéro",
    resetHint: "Le rappel recommence à compter à partir de maintenant",
    resetDone: "Le délai recommence.",
  },
  whatsNew: {
    button: "Nouveautés",
    title: "Nouveautés",
    revision: "Révision {{id}}",
    isNew: "Nouveau",
    footer: "S'ouvre seul à la connexion tant qu'une nouvelle révision n'a pas été lue.",
    understood: "Compris",
    empty: "Rien de nouveau pour l'instant.",
  },
};

export const en = {
  watch: {
    title: "Inactivity reminder",
    quiet: "No activity for {{count}} working days",
    every: "Reminder after {{count}} working days without activity",
    days: "Working days before the reminder",
    daysUnit: "working days",
    daysHint: "Empty = the usual delay (3 working days, 6 when the due day is more than 3 weeks away)",
    reset: "Reset",
    resetHint: "The reminder starts counting again from now",
    resetDone: "The delay starts again.",
  },
  whatsNew: {
    button: "What's new",
    title: "What's new",
    revision: "Revision {{id}}",
    isNew: "New",
    footer: "Opens by itself at sign-in until the newest revision has been read.",
    understood: "Got it",
    empty: "Nothing new yet.",
  },
};
