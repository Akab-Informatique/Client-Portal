/**
 * The IT checklist of a "new client, site visit" quote: gone through with the
 * client in the meeting, every answer feeds the quote (users, devices,
 * licences, risks to fix). Answers are kept as text by field key
 * ("devices.laptop.qty", "security.mfa_admin"), so a section or a field can
 * be added here without touching the database.
 */
export type L = { fr: string; en: string };
/** ynu: Oui / Non / ? · check: a box · the others as typed */
export type FieldType = "text" | "long" | "number" | "date" | "check" | "ynu";
export type SurveyField = {
  key: string;
  label: L;
  type: FieldType;
  /** What makes it a risk to fix: "yes" = checked / answered yes · "no" = answered no */
  risk?: "yes" | "no";
};
export type SurveyTable = {
  key: string;
  rows: { key: string; label: L }[];
  cols: { key: string; label: L; type: "number" | "text" }[];
};
export type SurveyBlock = { fields: SurveyField[] } | { table: SurveyTable };
export type SurveySection = { key: string; title: L; blocks: SurveyBlock[] };

const f = (key: string, fr: string, en: string, type: FieldType = "text", risk?: "yes" | "no"): SurveyField => ({ key, label: { fr, en }, type, ...(risk ? { risk } : {}) });
const row = (key: string, fr: string, en: string) => ({ key, label: { fr, en } });
const col = (key: string, fr: string, en: string, type: "number" | "text" = "text") => ({ key, label: { fr, en }, type });

export const SURVEY: SurveySection[] = [
  {
    key: "general",
    title: { fr: "Informations générales", en: "General information" },
    blocks: [
      {
        fields: [
          f("company", "Nom de l'entreprise", "Company name"),
          f("sector", "Secteur d'activité", "Industry"),
          f("addresses", "Adresse(s)", "Address(es)", "long"),
          f("sites", "Nombre de sites", "Number of sites", "number"),
          f("contact_name", "Contact principal", "Main contact"),
          f("contact_title", "Titre", "Title"),
          f("contact_email", "Courriel", "Email"),
          f("contact_cell", "Cellulaire", "Mobile"),
          f("signer", "Décideur / signataire", "Decision maker / signer"),
          f("billing_contact", "Contact facturation", "Billing contact"),
          f("employees", "Nombre d'employés", "Number of employees", "number"),
          f("users", "Nombre d'usagers TI", "Number of IT users", "number"),
          f("remote", "Télétravail et appareils mobiles", "Remote work and mobile devices", "long"),
          f("hours", "Heures d'ouverture (soir, fin de semaine)", "Opening hours (evenings, weekends)"),
          f("growth", "Croissance prévue sur 12 mois", "Expected growth over 12 months"),
          f("meeting_date", "Date de la rencontre", "Meeting date", "date"),
          f("written_by", "Rédigé par", "Written by"),
        ],
      },
    ],
  },
  {
    key: "devices",
    title: { fr: "Postes de travail et appareils", en: "Workstations and devices" },
    blocks: [
      {
        table: {
          key: "devices",
          rows: [
            row("desktop", "Ordinateurs de bureau", "Desktops"),
            row("laptop", "Portables", "Laptops"),
            row("aio", "Tout-en-un / mini PC", "All-in-one / mini PC"),
            row("mac", "Mac", "Mac"),
            row("tablet", "Tablettes", "Tablets"),
            row("phone", "Cellulaires", "Mobile phones"),
            row("monitor", "Écrans", "Monitors"),
          ],
          cols: [col("qty", "Qté", "Qty", "number"), col("model", "Marque / modèle", "Brand / model"), col("age", "Âge moyen", "Average age"), col("os", "OS / version", "OS / version"), col("notes", "Notes", "Notes")],
        },
      },
      {
        fields: [
          f("win10", "Postes Windows 10 ou non compatibles Windows 11", "Windows 10 or Windows 11 incompatible PCs", "check", "yes"),
          f("warranty", "Garanties actives", "Active warranties", "ynu", "no"),
          f("local_admin", "Usagers administrateurs locaux", "Users with local admin rights", "check", "yes"),
          f("byod", "Appareils personnels (BYOD)", "Personal devices (BYOD)", "check"),
          f("shared", "Postes partagés, de production ou kiosques", "Shared, production or kiosk PCs", "check"),
          f("mdm", "Gestion des cellulaires (Intune / MDM)", "Mobile management (Intune / MDM)", "ynu", "no"),
        ],
      },
    ],
  },
  {
    key: "servers",
    title: { fr: "Serveurs et infrastructure", en: "Servers and infrastructure" },
    blocks: [
      {
        table: {
          key: "servers",
          rows: [row("physical", "Serveurs physiques", "Physical servers"), row("virtual", "Serveurs virtuels", "Virtual servers")],
          cols: [col("qty", "Nombre", "Count", "number"), col("model", "Marque / modèle (ou hyperviseur)", "Brand / model (or hypervisor)"), col("age", "Âge", "Age"), col("notes", "Notes", "Notes")],
        },
      },
      {
        fields: [
          f("roles", "Rôles (AD, fichiers, impression, applications, SQL)", "Roles (AD, files, print, applications, SQL)", "long"),
          f("winserver", "Version de Windows Server", "Windows Server version"),
          f("cloud", "Infonuagique (Azure, AWS, hébergeur)", "Cloud (Azure, AWS, host)"),
          f("nas", "NAS", "NAS"),
          f("domain", "Domaine local, Entra ID ou hybride", "On-premises domain, Entra ID or hybrid"),
          f("ups", "UPS (âge des batteries)", "UPS (battery age)"),
          f("serverroom", "Salle serveur", "Server room"),
          f("unsupported", "Serveurs hors garantie ou OS hors support", "Out-of-warranty servers or unsupported OS", "check", "yes"),
          f("rdp_exposed", "RDP exposé sur internet", "RDP exposed to the internet", "check", "yes"),
          f("vpn_access", "Accès à distance par VPN", "Remote access by VPN", "check"),
          f("rds", "Bureau à distance (RDS)", "Remote desktop (RDS)", "check"),
        ],
      },
    ],
  },
  {
    key: "network",
    title: { fr: "Réseau et internet", en: "Network and internet" },
    blocks: [
      {
        fields: [
          f("isp", "Fournisseur internet", "Internet provider"),
          f("speed", "Vitesse", "Speed"),
          f("backup_link", "Lien de relève", "Backup link", "ynu"),
          f("static_ip", "IP fixe", "Static IP", "ynu"),
          f("firewall", "Pare-feu (marque)", "Firewall (brand)"),
          f("firewall_lic", "Licences du pare-feu et échéance", "Firewall licences and expiry"),
          f("switches", "Switchs / PoE", "Switches / PoE"),
          f("wifi", "Wi-Fi (nombre de bornes, couverture)", "Wi-Fi (access points, coverage)"),
          f("guest_wifi", "Réseau invité", "Guest network", "ynu"),
          f("vpn", "VPN", "VPN"),
          f("intersite", "Liens entre les sites", "Links between sites"),
          f("cabling", "Câblage et armoire", "Cabling and rack"),
          f("admin_access", "Accès administrateur disponibles", "Admin access available", "ynu", "no"),
          f("admin_holder", "Qui détient les accès", "Who holds the access"),
          f("netdoc", "Documentation réseau", "Network documentation", "ynu", "no"),
          f("cameras_same_net", "Caméras ou contrôle d'accès sur le même réseau", "Cameras or access control on the same network", "check", "yes"),
        ],
      },
    ],
  },
  {
    key: "security",
    title: { fr: "Sécurité", en: "Security" },
    blocks: [
      {
        fields: [
          f("av", "Antivirus / EDR actuel (produit)", "Current antivirus / EDR (product)"),
          f("av_lic", "Licences et échéance", "Licences and expiry"),
          f("av_manager", "Qui le gère", "Who manages it"),
          f("mail_filter", "Filtrage courriel", "Email filtering"),
          f("mfa_mail", "MFA sur le courriel", "MFA on email", "ynu", "no"),
          f("mfa_vpn", "MFA sur le VPN", "MFA on the VPN", "ynu", "no"),
          f("mfa_admin", "MFA sur les comptes administrateurs", "MFA on admin accounts", "ynu", "no"),
          f("pwd_manager", "Gestionnaire de mots de passe", "Password manager", "ynu", "no"),
          f("pwd_policy", "Politique de mots de passe", "Password policy"),
          f("updates", "Mises à jour (comment)", "Updates (how)"),
          f("bitlocker", "BitLocker (chiffrement des disques)", "BitLocker (disk encryption)", "ynu", "no"),
          f("training", "Formation de sensibilisation", "Awareness training", "ynu", "no"),
          f("incidents", "Incidents des 3 dernières années", "Incidents in the last 3 years", "long"),
          f("shared_accounts", "Comptes partagés", "Shared accounts", "check", "yes"),
          f("offboarding", "Accès désactivés au départ d'un employé", "Access disabled when an employee leaves", "ynu", "no"),
          f("written_policy", "Politique de sécurité écrite", "Written security policy", "ynu", "no"),
        ],
      },
    ],
  },
  {
    key: "insurance",
    title: { fr: "Cyberassurance et conformité", en: "Cyber insurance and compliance" },
    blocks: [
      {
        fields: [
          f("has", "Cyberassurance", "Cyber insurance", "ynu", "no"),
          f("insurer", "Assureur / courtier", "Insurer / broker"),
          f("coverage", "Couverture et franchise", "Coverage and deductible"),
          f("renewal", "Date de renouvellement", "Renewal date", "date"),
          f("requirements", "Exigences de l'assureur (MFA, EDR, sauvegardes hors ligne, formation)", "Insurer requirements (MFA, EDR, offline backups, training)", "long"),
          f("questionnaire", "Questionnaire de l'assureur disponible", "Insurer questionnaire available", "ynu"),
          f("law25", "Loi 25 : responsable des renseignements personnels nommé", "Law 25: privacy officer appointed", "ynu", "no"),
          f("sensitive", "Données sensibles (santé, financières, NAS, cartes de crédit)", "Sensitive data (health, financial, SIN, credit cards)", "long"),
          f("other_requirements", "Autres exigences (ordre professionnel, PCI)", "Other requirements (professional order, PCI)"),
        ],
      },
    ],
  },
  {
    key: "backup",
    title: { fr: "Sauvegardes et continuité", en: "Backups and continuity" },
    blocks: [
      {
        fields: [
          f("product", "Produit de sauvegarde", "Backup product"),
          f("what", "Ce qui est sauvegardé (serveurs, postes, M365, NAS)", "What is backed up (servers, PCs, M365, NAS)", "long"),
          f("frequency", "Fréquence et rétention", "Frequency and retention"),
          f("offsite", "Copie hors site", "Off-site copy", "ynu", "no"),
          f("immutable", "Copie immuable ou hors ligne", "Immutable or offline copy", "ynu", "no"),
          f("last_test", "Dernier test de restauration", "Last restore test"),
          f("monitored_by", "Qui surveille", "Who monitors it"),
          f("rto", "Temps d'arrêt tolérable", "Tolerable downtime"),
          f("rpo", "Perte de données tolérable", "Tolerable data loss"),
          f("plan", "Plan de relève écrit", "Written recovery plan", "ynu", "no"),
        ],
      },
    ],
  },
  {
    key: "m365",
    title: { fr: "Courriel, Microsoft 365 et licences", en: "Email, Microsoft 365 and licences" },
    blocks: [
      {
        fields: [
          f("platform", "Plateforme de courriel", "Email platform"),
          f("license_type", "Type de licences", "Licence type"),
          f("license_count", "Nombre de licences", "Number of licences", "number"),
          f("purchased", "Où elles sont achetées", "Where they are bought"),
          f("more", "Autres notes (la suite du formulaire s'ajoutera ici)", "Other notes (the rest of the form will go here)", "long"),
        ],
      },
    ],
  },
];

export const surveyKey = (section: string, ...rest: string[]) => [section, ...rest].join(".");

const fieldsOf = (s: SurveySection): { key: string; field?: SurveyField }[] =>
  s.blocks.flatMap((b) =>
    "fields" in b
      ? b.fields.map((x) => ({ key: surveyKey(s.key, x.key), field: x }))
      : b.table.rows.flatMap((r) => b.table.cols.map((c) => ({ key: surveyKey(s.key, b.table.key, r.key, c.key) }))),
  );

const num = (v: string | undefined) => {
  const n = Number((v ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** What the answers say so far: the figures a quote is built on, and the risks to fix. */
export function surveySummary(answers: Record<string, string>) {
  const a = (k: string) => answers[k] ?? "";
  const qty = (table: string, rows: string[], section: string) => rows.reduce((n, r) => n + num(a(surveyKey(section, table, r, "qty"))), 0);
  const risks: { section: string; field: SurveyField }[] = [];
  let answered = 0;
  let total = 0;
  for (const s of SURVEY) {
    for (const x of fieldsOf(s)) {
      total += 1;
      const v = a(x.key);
      if (v && v !== "0") answered += 1;
      if (x.field?.risk && ((x.field.risk === "yes" && (v === "1" || v === "yes")) || (x.field.risk === "no" && v === "no"))) risks.push({ section: s.key, field: x.field });
    }
  }
  return {
    users: num(a("general.users")),
    workstations: qty("devices", ["desktop", "laptop", "aio", "mac"], "devices"),
    mobiles: qty("devices", ["tablet", "phone"], "devices"),
    monitors: qty("devices", ["monitor"], "devices"),
    servers: qty("servers", ["physical", "virtual"], "servers"),
    licences: num(a("m365.license_count")),
    answered,
    total,
    risks,
  };
}
