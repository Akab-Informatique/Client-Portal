/**
 * The wording an invoice starts with (Admin › Facturation › Modèle de facture): the payment instructions under the
 * invoice and the conditions at the foot of it. Edited there afterwards; "Appliquer le modèle par défaut" loads them again.
 * The bank details are left blank on purpose: they are typed in the settings, never kept in the code.
 */
export type InvoiceLang = "fr" | "en";

export const DEFAULT_PAYMENT_TEXT: Record<InvoiceLang, string> = {
  fr: `Merci de faire confiance à Akab Informatique.
Les paiements peuvent être effectués par carte de crédit ou par virement bancaire. Pour les virements bancaires, veuillez indiquer le numéro de facture en référence et nous transmettre un avis de paiement.
Merci !

Desjardins :
   institution : ___
   transit : ___
   compte : ___

Merci de mettre en référence le numéro de facture lorsque vous effectuez un paiement et de nous transmettre un avis de paiement.

Pour des transferts Interac, veuillez les envoyer à comptesrecevables@akab.ca. Pour la question de sécurité, vous pouvez y insérer ce que vous désirez, mais veuillez utiliser le numéro de facture comme réponse.`,
  en: `Thank you for trusting Akab Informatique.
Payments can be made by credit card or bank transfer. For bank transfers, please quote the invoice number as the reference and send us a payment notice.
Thank you!

Desjardins:
   institution: ___
   transit: ___
   account: ___

Please quote the invoice number when you make a payment and send us a payment notice.

For Interac transfers, please send them to comptesrecevables@akab.ca. For the security question, you may enter whatever you like, but please use the invoice number as the answer.`,
};

export const DEFAULT_FOOTER_TEXT: Record<InvoiceLang, string> = {
  fr: `• Pour les commandes de matériel, un paiement de 50 % devra être effectué avant de pouvoir procéder à la commande.
• Le temps est une estimation et peut varier. Nos techniciens vous tiendront informés, et seul le temps travaillé sera facturé.
• Akab est un MSP (« multiservice provider ») revendeur/gestionnaire de services. Nous ne pouvons être tenus responsables des changements ou dysfonctionnements des fournisseurs (sauvegarde, antivirus, cloud, etc.). Cependant, Akab veille au bon fonctionnement des services et gère vos alertes pour vous en informer en cas de besoin.`,
  en: `• For hardware orders, a 50% payment is required before the order can be placed.
• Time is an estimate and may vary. Our technicians will keep you informed, and only the time actually worked will be billed.
• Akab is an MSP ("multiservice provider") reselling and managing services. We cannot be held responsible for changes or malfunctions of suppliers (backup, antivirus, cloud, etc.). However, Akab watches over the proper operation of the services and manages your alerts to inform you when needed.`,
};
