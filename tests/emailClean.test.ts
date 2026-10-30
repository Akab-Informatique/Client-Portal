import { describe, expect, it } from "vitest";
import { cleanEmailText } from "../server/lib/emailClean.ts";

describe("email text for a ticket", () => {
  it("drops the phishing-filter banner, link brackets, image placeholders and the confidentiality notice, keeps what was written", () => {
    const raw = [
      "Bonjour Je voudrais avoir access pour Brenda pour Outlook web, Teams et Filemaker Aumoins qu il existe déjà une compte si c",
      "Mise en garde: Externe (pablo.leiva@pubco.ca<mailto:pablo.leiva@pubco.ca>)",
      "Contenu confidentiel  Détails<https://protection.inkyphishfence.com/details?id=YWthYi9qYm9pc3ZlcnRAYWthYi5jYS8zNTg4YjgwY2RIZDM0ZGE3ZGExZDE2YWI3MTIINjRIZC8xNzkzMzg3MDY4LjE1MjQyOTY>",
      "  Légitime<https://protection.inkyphishfence.com/report?id=abc&label=safe&quick=1&graymail_sender=1&key=d01771bbabc9e1c6104a44b7ec3f5d8d> FAQ<AKAB.CA> Protection par le service de Cyber Sécurité d'AKAB Informatique.<AKAB.CA>",
      "",
      "Bonjour",
      "",
      "Je voudrais avoir access pour Brenda.",
      "",
      "[Logo image]",
      "Pablo Leiva",
      "T: 228<tel:228> | M: 514-795-2972<tel:514-795-2972> | pablo.leiva@pubco.ca<mailto:pablo.leiva@pubco.ca>",
      "[Footer image]",
      "Confidentiality Notice: This message may contain confidential information.",
      "Avis de confidentialité : Ce message peut contenir des informations.",
    ].join("\n");
    const out = cleanEmailText(raw);
    expect(out).toBe("Bonjour\n\nJe voudrais avoir access pour Brenda.\n\nPablo Leiva\nT: 228 | M: 514-795-2972 | pablo.leiva@pubco.ca");
  });

  it("leaves a plain email alone and shortens a very long link", () => {
    expect(cleanEmailText("Salut,\r\n\r\n\r\n\r\nÀ demain.")).toBe("Salut,\n\nÀ demain.");
    expect(cleanEmailText(`Voir https://example.com/${"a".repeat(120)} merci`)).toBe("Voir [lien : example.com] merci");
    expect(cleanEmailText("Lien court https://akab.ca/aide ok")).toBe("Lien court https://akab.ca/aide ok");
  });
});
