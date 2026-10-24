import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { config } from "../config.ts";

/**
 * Email templates: built-in defaults (FR + EN) that admins can override in
 * Admin settings › Email. Texts are plain text with {{variables}}; a blank
 * line starts a new paragraph. The optional button links to `linkVar`.
 */
export type Locale = "fr" | "en";
export type TemplateText = { subject: string; body: string; action: string };
export type TemplateDef = {
  key: TemplateKey;
  /** Variable used as the button link */
  linkVar: string | null;
  variables: string[];
  defaults: Record<Locale, TemplateText>;
  sample: Record<Locale, Record<string, string>>;
};
export type TemplateKey =
  | "welcome"
  | "passwordReset"
  | "passwordChanged"
  | "boardMessage"
  | "ticketReceived"
  | "invoiceSent"
  | "invoicePastDue"
  | "invoiceReminder5"
  | "invoiceReminder15"
  | "invoiceReminder20"
  | "invoiceReminder30"
  | "invoiceReminder60"
  | "invoiceReminder90"
  | "accountStatement";

const SIGN = { fr: "L'équipe AKAB Informatique", en: "The AKAB Informatique team" };
const sampleBase = (l: Locale) => ({
  name: "Marie Tremblay",
  email: "marie@exemple.ca",
  portalUrl: config.publicUrl || "https://portail.akab.ca",
  link: `${config.publicUrl || "https://portail.akab.ca"}/reset-password?token=…`,
  date: new Intl.DateTimeFormat(l === "en" ? "en-CA" : "fr-CA", { dateStyle: "long", timeStyle: "short" }).format(new Date()),
});

export const TEMPLATES: TemplateDef[] = [
  {
    key: "welcome",
    linkVar: "link",
    variables: ["name", "email", "link", "expires", "portalUrl"],
    defaults: {
      fr: {
        subject: "Bienvenue sur le portail AKAB",
        body: `Bonjour {{name}},

Un compte a été créé pour vous sur le portail AKAB Informatique ({{email}}).

Cliquez sur le bouton ci-dessous pour choisir votre mot de passe. Ce lien est valide pendant {{expires}}.

À votre première connexion, vous configurerez aussi la vérification en deux étapes avec une application d'authentification (Microsoft Authenticator, Google Authenticator…).

${SIGN.fr}`,
        action: "Choisir mon mot de passe",
      },
      en: {
        subject: "Welcome to the AKAB portal",
        body: `Hello {{name}},

An account was created for you on the AKAB Informatique portal ({{email}}).

Click the button below to choose your password. This link is valid for {{expires}}.

At your first sign-in you will also set up two-step verification with an authenticator app (Microsoft Authenticator, Google Authenticator…).

${SIGN.en}`,
        action: "Choose my password",
      },
    },
    sample: { fr: { ...sampleBase("fr"), expires: "72 heures" }, en: { ...sampleBase("en"), expires: "72 hours" } },
  },
  {
    key: "passwordReset",
    linkVar: "link",
    variables: ["name", "email", "link", "expires"],
    defaults: {
      fr: {
        subject: "Réinitialisation de votre mot de passe",
        body: `Bonjour {{name}},

Nous avons reçu une demande de réinitialisation du mot de passe de votre compte AKAB ({{email}}).

Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe. Ce lien est valide pendant {{expires}} et ne fonctionne qu'une seule fois.

Si vous n'êtes pas à l'origine de cette demande, ignorez ce courriel : votre mot de passe actuel reste inchangé.

${SIGN.fr}`,
        action: "Réinitialiser mon mot de passe",
      },
      en: {
        subject: "Reset your password",
        body: `Hello {{name}},

We received a request to reset the password of your AKAB account ({{email}}).

Click the button below to choose a new password. This link is valid for {{expires}} and works only once.

If you did not make this request, ignore this email: your current password stays unchanged.

${SIGN.en}`,
        action: "Reset my password",
      },
    },
    sample: { fr: { ...sampleBase("fr"), expires: "60 minutes" }, en: { ...sampleBase("en"), expires: "60 minutes" } },
  },
  {
    key: "passwordChanged",
    linkVar: "portalUrl",
    variables: ["name", "email", "date", "portalUrl"],
    defaults: {
      fr: {
        subject: "Votre mot de passe a été modifié",
        body: `Bonjour {{name}},

Le mot de passe de votre compte AKAB ({{email}}) a été modifié le {{date}}.

Si vous n'êtes pas à l'origine de ce changement, communiquez immédiatement avec AKAB Informatique.

${SIGN.fr}`,
        action: "Ouvrir le portail",
      },
      en: {
        subject: "Your password was changed",
        body: `Hello {{name}},

The password of your AKAB account ({{email}}) was changed on {{date}}.

If you did not make this change, contact AKAB Informatique right away.

${SIGN.en}`,
        action: "Open the portal",
      },
    },
    sample: { fr: sampleBase("fr"), en: sampleBase("en") },
  },
  {
    key: "boardMessage",
    linkVar: "portalUrl",
    variables: ["name", "title", "body", "portalUrl"],
    defaults: {
      fr: {
        subject: "[AKAB] {{title}}",
        body: `Bonjour {{name}},

Nouveau message d'AKAB Informatique :

{{title}}

{{body}}

${SIGN.fr}`,
        action: "Ouvrir le portail",
      },
      en: {
        subject: "[AKAB] {{title}}",
        body: `Hello {{name}},

New message from AKAB Informatique:

{{title}}

{{body}}

${SIGN.en}`,
        action: "Open the portal",
      },
    },
    sample: {
      fr: { ...sampleBase("fr"), title: "Maintenance planifiée samedi", body: "Les serveurs seront redémarrés samedi entre 22 h et minuit." },
      en: { ...sampleBase("en"), title: "Planned maintenance Saturday", body: "Servers will be restarted Saturday between 10 PM and midnight." },
    },
  },
];

// the workflow "automatic reply to a new ticket" (Admin › Flux de travail)
TEMPLATES.push({
  key: "ticketReceived",
  linkVar: "ticketUrl",
  variables: ["name", "number", "title", "company", "ticketUrl", "portalUrl"],
  defaults: {
    fr: {
      subject: "[{{number}}] Nous avons bien reçu votre demande",
      body: `Bonjour {{name}},

Nous avons bien reçu votre demande « {{title}} ». Elle porte le numéro {{number}}.

Vous n'avez rien à faire pour le moment : un technicien d'AKAB Informatique la prendra en charge sous peu. Pour toute question, mentionnez le numéro {{number}}.

${SIGN.fr}`,
      action: "Voir mon billet",
    },
    en: {
      subject: "[{{number}}] We received your request",
      body: `Hello {{name}},

We received your request "{{title}}". Its number is {{number}}.

There is nothing you need to do for now: a technician from AKAB Informatique will take it on shortly. For any question, mention number {{number}}.

${SIGN.en}`,
      action: "View my ticket",
    },
  },
  sample: {
    fr: { ...sampleBase("fr"), number: "T20261019.0042", title: "Imprimante hors ligne à la réception", company: "Boulangerie Lanaudière", ticketUrl: `${config.publicUrl || "https://portail.akab.ca"}/tickets?t=42` },
    en: { ...sampleBase("en"), number: "T20261019.0042", title: "Printer offline at the front desk", company: "Boulangerie Lanaudière", ticketUrl: `${config.publicUrl || "https://portail.akab.ca"}/tickets?t=42` },
  },
});

// ── Invoicing (Admin › Facturation › Courriels): the invoice sent, past due notices and reminders, the account statement ──
/** Days past due at which a reminder goes out (the last one means "and more") */
export const REMINDER_LEVELS = [5, 15, 20, 30, 60, 90] as const;
export const reminderKey = (level: number) => `invoiceReminder${level}` as TemplateKey;
export const BILLING_TEMPLATE_KEYS: TemplateKey[] = ["invoiceSent", "invoicePastDue", ...REMINDER_LEVELS.map(reminderKey), "accountStatement"];

const invoiceVars = ["name", "company", "number", "issuedOn", "dueOn", "total", "balance", "daysLate", "poNumber", "portalUrl"];
const invoiceSample = (l: Locale, daysLate: string) => ({
  ...sampleBase(l),
  company: "Boulangerie Lanaudière",
  number: "F-10452",
  issuedOn: l === "en" ? "October 1, 2026" : "1 octobre 2026",
  dueOn: l === "en" ? "October 16, 2026" : "16 octobre 2026",
  total: l === "en" ? "$1,149.75" : "1 149,75 $",
  balance: l === "en" ? "$1,149.75" : "1 149,75 $",
  daysLate,
  poNumber: "PO-778",
});
const REMINDER_TEXT: Record<number, { fr: [string, string]; en: [string, string] }> = {
  5: {
    fr: ["Rappel : facture {{number}} échue", "Un petit rappel : la facture {{number}} de {{balance}} était due le {{dueOn}}. Elle n'apparaît pas encore comme payée de notre côté. Si le paiement est en route, vous pouvez ignorer ce message."],
    en: ["Reminder: invoice {{number}} is past due", "A friendly reminder: invoice {{number}} for {{balance}} was due on {{dueOn}}. It does not show as paid on our side yet. If payment is on its way, please ignore this message."],
  },
  15: {
    fr: ["Facture {{number}} en retard de {{daysLate}} jours", "La facture {{number}} de {{balance}}, due le {{dueOn}}, est en retard de {{daysLate}} jours. Nous vous demandons de la régler dès que possible ou de nous écrire si un problème retarde le paiement."],
    en: ["Invoice {{number}} is {{daysLate}} days past due", "Invoice {{number}} for {{balance}}, due on {{dueOn}}, is {{daysLate}} days past due. Please pay it as soon as possible, or write to us if something is holding up the payment."],
  },
  20: {
    fr: ["Deuxième rappel : facture {{number}}", "Malgré notre rappel, la facture {{number}} de {{balance}} reste impayée ({{daysLate}} jours de retard). Merci de la régler cette semaine ou de communiquer avec nous pour convenir d'une entente."],
    en: ["Second reminder: invoice {{number}}", "Despite our earlier reminder, invoice {{number}} for {{balance}} is still unpaid ({{daysLate}} days past due). Please pay it this week, or contact us to agree on an arrangement."],
  },
  30: {
    fr: ["Avis important : facture {{number}} en retard de plus de 30 jours", "La facture {{number}} de {{balance}} est en retard de {{daysLate}} jours. Sans paiement ou entente de votre part rapidement, nous devrons suspendre certains services. Communiquez avec nous dès aujourd'hui."],
    en: ["Important notice: invoice {{number}} is over 30 days past due", "Invoice {{number}} for {{balance}} is {{daysLate}} days past due. Without payment or an arrangement from you soon, we may have to suspend some services. Please contact us today."],
  },
  60: {
    fr: ["Avis de retard sérieux : facture {{number}} (plus de 60 jours)", "La facture {{number}} de {{balance}} est en retard de {{daysLate}} jours. Votre compte est en souffrance. Veuillez la régler immédiatement; à défaut, nous devrons prendre les mesures prévues à notre entente de service."],
    en: ["Serious past-due notice: invoice {{number}} (over 60 days)", "Invoice {{number}} for {{balance}} is {{daysLate}} days past due. Your account is delinquent. Please pay it immediately; otherwise we will have to take the steps set out in our service agreement."],
  },
  90: {
    fr: ["Dernier avis : facture {{number}} (plus de 90 jours)", "La facture {{number}} de {{balance}} est en retard de {{daysLate}} jours. C'est notre dernier avis avant d'entreprendre des démarches de recouvrement. Pour l'éviter, réglez le solde aujourd'hui ou communiquez avec nous."],
    en: ["Final notice: invoice {{number}} (over 90 days)", "Invoice {{number}} for {{balance}} is {{daysLate}} days past due. This is our final notice before we begin collection steps. To avoid this, pay the balance today or contact us."],
  },
};
for (const level of REMINDER_LEVELS) {
  const t = REMINDER_TEXT[level];
  TEMPLATES.push({
    key: reminderKey(level),
    linkVar: null,
    variables: invoiceVars,
    defaults: {
      fr: { subject: t.fr[0], body: `Bonjour {{name}},\n\n${t.fr[1]}\n\nFacture : {{number}} · Date : {{issuedOn}} · Échéance : {{dueOn}} · Solde : {{balance}}\n\n${SIGN.fr}`, action: "" },
      en: { subject: t.en[0], body: `Hello {{name}},\n\n${t.en[1]}\n\nInvoice: {{number}} · Date: {{issuedOn}} · Due: {{dueOn}} · Balance: {{balance}}\n\n${SIGN.en}`, action: "" },
    },
    sample: { fr: invoiceSample("fr", String(level)), en: invoiceSample("en", String(level)) },
  });
}
TEMPLATES.push(
  {
    key: "invoiceSent",
    linkVar: null,
    variables: invoiceVars,
    defaults: {
      fr: {
        subject: "Facture {{number}} d'AKAB Informatique",
        body: `Bonjour {{name}},\n\nVoici votre facture {{number}} du {{issuedOn}}, d'un montant de {{total}}. Elle est payable au plus tard le {{dueOn}}.\n\nPour toute question au sujet de cette facture, répondez simplement à ce courriel en mentionnant le numéro {{number}}.\n\nMerci de votre confiance,\n${SIGN.fr}`,
        action: "",
      },
      en: {
        subject: "Invoice {{number}} from AKAB Informatique",
        body: `Hello {{name}},\n\nHere is your invoice {{number}} dated {{issuedOn}}, for {{total}}. It is payable no later than {{dueOn}}.\n\nFor any question about this invoice, simply reply to this email and mention number {{number}}.\n\nThank you for your business,\n${SIGN.en}`,
        action: "",
      },
    },
    sample: { fr: invoiceSample("fr", "0"), en: invoiceSample("en", "0") },
  },
  {
    key: "invoicePastDue",
    linkVar: null,
    variables: invoiceVars,
    defaults: {
      fr: {
        subject: "Facture {{number}} échue",
        body: `Bonjour {{name}},\n\nLa facture {{number}} de {{balance}} était due le {{dueOn}} et n'est pas encore payée. Pourriez-vous la régler dès que possible?\n\nSi le paiement a déjà été fait, merci de nous en aviser et d'ignorer ce message.\n\n${SIGN.fr}`,
        action: "",
      },
      en: {
        subject: "Invoice {{number}} is past due",
        body: `Hello {{name}},\n\nInvoice {{number}} for {{balance}} was due on {{dueOn}} and has not been paid yet. Could you please pay it as soon as possible?\n\nIf payment has already been made, please let us know and ignore this message.\n\n${SIGN.en}`,
        action: "",
      },
    },
    sample: { fr: invoiceSample("fr", "2"), en: invoiceSample("en", "2") },
  },
  {
    key: "accountStatement",
    linkVar: null,
    variables: ["name", "company", "date", "count", "totalDue", "overdueDue", "statementLines", "portalUrl"],
    defaults: {
      fr: {
        subject: "Relevé de compte — {{company}} au {{date}}",
        body: `Bonjour {{name}},\n\nVoici le relevé de votre compte au {{date}}. Solde à payer : {{totalDue}}, dont {{overdueDue}} en retard.\n\n{{statementLines}}\n\nSi un paiement a croisé ce relevé, merci de ne pas en tenir compte. Pour toute question, répondez à ce courriel.\n\n${SIGN.fr}`,
        action: "",
      },
      en: {
        subject: "Account statement — {{company}} as of {{date}}",
        body: `Hello {{name}},\n\nHere is the statement of your account as of {{date}}. Balance due: {{totalDue}}, of which {{overdueDue}} is past due.\n\n{{statementLines}}\n\nIf a payment crossed this statement, please disregard it. For any question, reply to this email.\n\n${SIGN.en}`,
        action: "",
      },
    },
    sample: {
      fr: {
        ...sampleBase("fr"),
        company: "Boulangerie Lanaudière",
        count: "2",
        totalDue: "1 724,63 $",
        overdueDue: "574,88 $",
        statementLines: "F-10452 · du 1 octobre 2026 · échéance 16 octobre 2026 · solde 1 149,75 $\nF-10389 · du 15 septembre 2026 · échéance 1 octobre 2026 · solde 574,88 $ (22 jours de retard)",
      },
      en: {
        ...sampleBase("en"),
        company: "Boulangerie Lanaudière",
        count: "2",
        totalDue: "$1,724.63",
        overdueDue: "$574.88",
        statementLines: "F-10452 · dated October 1, 2026 · due October 16, 2026 · balance $1,149.75\nF-10389 · dated September 15, 2026 · due October 1, 2026 · balance $574.88 (22 days past due)",
      },
    },
  },
);

export const templateDef = (key: string) => TEMPLATES.find((t) => t.key === key) ?? null;

/** The text used for a template: the admin's version if edited, else the default. */
export async function templateText(key: TemplateKey, locale: Locale): Promise<TemplateText> {
  const [row] = await db()
    .select()
    .from(schema.emailTemplates)
    .where(and(eq(schema.emailTemplates.key, key), eq(schema.emailTemplates.locale, locale)));
  return row ? { subject: row.subject, body: row.body, action: row.action } : templateDef(key)!.defaults[locale];
}

// ── Rendering ──────────────────────────────────────────────────────────────────
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

const fill = (s: string, vars: Record<string, string>, map: (v: string) => string = (v) => v) =>
  s.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in vars ? map(vars[k]) : m));

export type Rendered = { subject: string; text: string; html: string };

export function render(def: TemplateDef, locale: Locale, tpl: TemplateText, vars: Record<string, string>): Rendered {
  const subject = fill(tpl.subject, vars).replace(/[\r\n]+/g, " ").trim();
  const link = def.linkVar ? vars[def.linkVar] : "";
  const action = fill(tpl.action, vars).trim();
  const showButton = Boolean(action && link && /^https?:\/\//.test(link));

  const text = `${fill(tpl.body, vars).trim()}${showButton ? `\n\n${action} : ${link}` : ""}\n`;

  // Variables are escaped; newlines inside a paragraph become <br>
  const paragraphs = tpl.body
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p style="margin:0 0 16px;line-height:1.6">${fill(escapeHtml(p), vars, escapeHtml).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  const button = showButton
    ? `<p style="margin:24px 0 8px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#ffce1a;background-image:linear-gradient(135deg,#ffe24a,#ffce1a 50%,#f59410);color:#1a1204;padding:12px 22px;border-radius:12px;text-decoration:none;font-weight:700">${escapeHtml(action)}</a></p>
<p style="margin:0;font-size:12px;color:#8a8c93;word-break:break-all">${escapeHtml(link)}</p>`
    : "";
  const footer = locale === "en" ? "AKAB Informatique · Lanaudière, Québec" : "AKAB Informatique · Lanaudière, Québec";

  const html = `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f1">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f1;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e6e6e1">
<tr><td style="background:#0a0a0b;padding:20px 28px;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:800;color:#ffffff">
<span style="color:#ffce1a">AKAB</span> Informatique</td></tr>
<tr><td style="height:3px;background:#ffce1a;background-image:linear-gradient(90deg,#ffe24a,#ffce1a,#f59410)"></td></tr>
<tr><td style="padding:28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#16171b">
${paragraphs}
${button}
</td></tr>
</table>
<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8a8c93;margin:16px 0 0">${footer}</p>
</td></tr></table>
</body></html>`;
  return { subject, text, html };
}

/** Render a template with the saved (or default) text. */
export async function renderTemplate(key: TemplateKey, locale: Locale, vars: Record<string, string>): Promise<Rendered> {
  return render(templateDef(key)!, locale, await templateText(key, locale), vars);
}
