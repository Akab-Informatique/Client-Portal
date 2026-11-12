/** Texts of the self-managed clients feature (client side): kept in their own file so parallel work never touches fr.ts / en.ts. Keys live under `selfManaged.client`. */
export const fr = {
  selfManaged: {
    client: {
      company: {
        label: "Entreprise",
        home: "Mon entreprise",
        via: "Filiale de {{name}}",
        switched: "Entreprise changée.",
        error: "Impossible de changer d'entreprise.",
        choose: "Changer d'entreprise",
      },
      grants: {
        title: "Accès à d'autres entreprises",
        text: "L'usager pourra passer à ces entreprises avec le menu en haut à gauche ; ses droits y sont ceux du rôle choisi pour cette entreprise.",
        home: "Entreprise principale",
        add: "Ajouter une entreprise",
        pick: "Choisir une entreprise",
        role: "Rôle",
        pickRole: "Choisir un rôle",
        noRole: "Aucun rôle pour cette entreprise",
        remove: "Retirer cet accès",
        empty: "Aucun accès à d'autres entreprises.",
        noCandidates: "Aucune autre entreprise dans cette chaîne.",
        save: "Enregistrer les accès",
        saved: "Accès enregistrés.",
        relation: {
          parent: "Maison mère",
          grandparent: "Grande maison mère",
          ancestor: "Société mère",
          child: "Filiale",
          grandchild: "Petite-filiale",
          descendant: "Descendante",
        },
        errors: {
          company_not_in_chain: "Cette entreprise ne fait pas partie de la chaîne de l'usager.",
          invalid_role: "Ce rôle ne peut pas être donné pour cette entreprise.",
          is_home_company: "C'est déjà l'entreprise principale de l'usager.",
          generic: "Impossible d'enregistrer les accès.",
        },
      },
    },
  },
};

export const en = {
  selfManaged: {
    client: {
      company: {
        label: "Company",
        home: "My company",
        via: "Subsidiary of {{name}}",
        switched: "Company switched.",
        error: "Could not switch company.",
        choose: "Switch company",
      },
      grants: {
        title: "Access to other companies",
        text: "The user can switch to these companies with the menu at the top left; their rights there are those of the role chosen for each company.",
        home: "Main company",
        add: "Add a company",
        pick: "Choose a company",
        role: "Role",
        pickRole: "Choose a role",
        noRole: "No role for this company",
        remove: "Remove this access",
        empty: "No access to other companies.",
        noCandidates: "No other company in this chain.",
        save: "Save access",
        saved: "Access saved.",
        relation: {
          parent: "Parent company",
          grandparent: "Grand-parent company",
          ancestor: "Holding company",
          child: "Subsidiary",
          grandchild: "Sub-subsidiary",
          descendant: "Descendant",
        },
        errors: {
          company_not_in_chain: "This company is not part of the user's chain.",
          invalid_role: "This role cannot be given for this company.",
          is_home_company: "This is already the user's main company.",
          generic: "Could not save the access.",
        },
      },
    },
  },
};
