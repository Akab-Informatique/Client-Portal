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
export type TemplateKey = "welcome" | "passwordReset" | "passwordChanged" | "boardMessage" | "ticketReceived";

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
