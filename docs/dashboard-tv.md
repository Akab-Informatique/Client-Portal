# Dashboard TV — mise en production

L'enseigne de la télé du hall : le bureau des robots IA (Clicky, Finance, Adjointe, Portail AKAB, Boss,
Facebook, Légale, Vidéaste, L'artiste), avec Jonathan, Alexandre et Camille. Les robots passent « au
travail », « au repos » ou « besoin d'un humain » quand ils ouvrent leur lien secret. Le code, les
routes et les règles sont décrits dans la section « Dashboard TV » de `CLAUDE.md` ; ce guide sert à la
mise en service.

## Ce qui est public, ce qui ne l'est pas

- L'écran de la télé et les liens des robots n'ont **pas de session** : ils sont protégés par des clés
  secrètes dans l'adresse.
- Seuls les **noms des robots** et les **45 tâches approuvées** (liste plus bas) sortent du serveur. Un
  texte libre n'est jamais gardé : il devient « Tâche en cours » ou « Besoin d'aide ». Aucun nom de client,
  aucun montant. Le nombre de billets non assignés est le seul chiffre du portail qui sort.
- Les clés ne sont jamais dans les réponses publiques ni dans les journaux (`/api/tv/r/***`).

## 1. Déployer

Comme les autres mises à jour (voir `INSTALL.md`) :

```bash
cd /opt/akab-portal
git pull
docker compose up -d --build
```

- La migration `0182` crée les tables `tv_bots` et `tv_status` au démarrage. Elle n'ajoute que des
  tables : rien d'existant n'est modifié.
- Les 9 robots de départ sont créés au premier accès au menu, tous « au repos ».
- Si le portail est derrière un proxy, `TRUSTED_PROXY_IPS` doit être réglé comme pour le reste du
  portail : les limites (120 lectures par minute, 60 rapports par minute, 10 clés fausses par minute et
  par adresse) se calculent sur l'adresse réelle du visiteur.

## 2. Vérifier après le déploiement

1. Connecté en administrateur, ouvrir **Équipe › Dashboard TV** (`/tv`) : le bureau s'affiche et
   l'horloge indique l'heure du Québec.
2. En bas, dans **Gérer**, copier le **lien d'affichage de la télé** (`https://<portail>/tv/index.html?key=…`).
3. Ouvrir ce lien dans une fenêtre privée : le bureau doit s'afficher sans connexion.
4. Dans **Gérer**, ouvrir un robot, cliquer « Définir l'état » → travail : le robot s'assoit et sa tâche
   apparaît sur la télé en moins de 5 secondes.
5. Droits : `tv.view` (voir la page) pour les administrateurs et les techniciens, `tv.manage` (robots,
   liens, clé) pour les administrateurs seulement. Lecture seule n'a aucun des deux.

## 3. Le PC derrière la télé

Le PC ouvre simplement l'adresse avec la clé en plein écran. Il n'a besoin d'aucun compte.

1. Windows : désactiver la mise en veille de l'écran et du PC, ouvrir la session automatiquement,
   régler l'heure sur Internet. (L'horloge de la page est forcée à l'heure du Québec, mais le reste du PC
   doit être juste.)
2. Créer `start-tv.cmd` et placer un raccourci dans le dossier Démarrage (`Win+R`, `shell:startup`) :

```bat
@echo off
rem Remplacer l'adresse par le lien d'affichage copié dans Dashboard TV > Gérer
start "" msedge --kiosk "https://portail.akab.ca/tv/index.html?key=REMPLACER" --edge-kiosk-type=fullscreen --no-first-run
```

3. La page est faite pour tourner sans surveillance : elle se reconnecte seule si le réseau tombe (une
   petite icône « hors ligne » apparaît après 20 secondes sans données), se recharge chaque jour à 4 h et
   quand le portail est mis à jour. Pour quitter le mode kiosque : `Alt+F4`.
4. **Traiter le lien comme un mot de passe** : il est dans le raccourci du PC. Si le PC est perdu ou le
   lien partagé, régénérer la clé (voir « Exploitation ») et mettre à jour le raccourci.

## 4. Brancher les robots (Grok)

Chaque robot a ses **propres liens secrets** (**Équipe › Dashboard TV › Gérer**, flèche à gauche du nom du robot).
Il suffit de les ouvrir (GET ou POST) :

| Lien | Effet |
|------|-------|
| `https://<portail>/api/tv/r/<clé>/working/<n>` | travaille, avec la tâche numéro `<n>` du tableau plus bas |
| `https://<portail>/api/tv/r/<clé>/working` | travaille, tâche générique « Tâche en cours » |
| `https://<portail>/api/tv/r/<clé>/needs_human` | a besoin d'un humain (la main levée, la file près d'Alexandre) |
| `https://<portail>/api/tv/r/<clé>/idle` | au repos |

Le serveur répond `OK <Nom> <état>`. Une clé inconnue donne 404 comme n'importe quelle adresse. Les mots
`travail`, `repos`, `aide` marchent aussi à la place de `working`, `idle`, `needs_human`.

**Les instructions pour Grok sont déjà prêtes** : dans **Gérer**, le bouton **« Copie des instructions des
bots »** copie un texte complet pour tous les robots : la règle (ouvrir un lien au début, en cas de blocage et à la fin
d'une tâche), la liste numérotée des tâches approuvées (0 à 44) et, pour chaque robot (`=== Nom ===`), ses trois
liens secrets. À coller dans Grok, chaque robot ne devant recevoir que **son** bloc. Ce texte contient des clés :
ne pas le coller ailleurs qu'à Grok, et ne pas l'enregistrer dans un fichier ou un dépôt.

Règles à garder dans ce que reçoit chaque robot : n'écrire dans le lien aucun nom de client, de personne ni
de montant (l'écran est public) ; choisir le numéro de la tâche la plus proche de son rôle (tableau plus bas) ; si
l'ouverture du lien échoue, continuer la tâche normalement et réessayer à l'étape suivante.

### Les tâches approuvées (numéro → texte affiché)

Chaque robot peut envoyer n'importe quel numéro ; voici celles qui correspondent à son rôle :

| Robot | Numéros |
|-------|---------|
| Clicky | 12 Réponse aux questions · 13 Recherche d'information · 14 Résumé de réunion · 15 Organisation des tâches |
| Finance | 16 Rapprochement bancaire · 8 Vérification des factures · 17 Suivi des comptes clients · 18 Préparation de la paie · 19 Rapport financier |
| Adjointe | 20 Gestion de l'agenda · 0 Tri des courriels · 21 Préparation de réunion · 9 Classement des documents · 22 Suivi des échéances |
| Portail AKAB | 23 Consultation des billets ouverts · 24 Suivi des billets · 25 Mise à jour du portail · 6 Support technique |
| Boss | 26 Supervision de l'équipe · 27 Revue des priorités · 28 Répartition des tâches · 11 Contrôle qualité |
| Facebook | 29 Vérification des publicités Meta · 30 Publication Marketplace · 31 Mise à jour des annonces · 32 Réponse aux messages |
| Légale | 33 Révision de contrat · 34 Vérification de conformité · 35 Rédaction de document légal · 36 Suivi des échéances légales |
| Vidéaste | 37 Édition d'une vidéo · 38 Montage vidéo · 39 Mixage audio · 40 Rendu de la vidéo |
| L'artiste | 41 Création graphique · 42 Retouche d'images · 43 Cadrage de la vidéo · 44 Choix des accessoires |

Les autres (communes) : 1 Mise à jour des postes · 2 Sauvegarde des données · 3 Surveillance réseau ·
4 Rédaction de rapport · 5 Analyse de sécurité · 7 Planification · 10 Synchronisation des calendriers.
Les numéros sont ceux du tableau « Gérer » du portail ; si la liste change dans le code (`LABELS`,
`server/lib/tv.ts`), mettre ce tableau à jour.

À tester avec **un seul robot** d'abord : ouvrir son lien « travail » depuis un navigateur, voir le robot
s'asseoir à l'écran, puis demander à Grok de le faire lui-même. On ne sait pas encore si Grok peut ouvrir
un lien web de lui-même (non confirmé) ; si ce n'est pas possible, il faudra une autre méthode (par
exemple un courriel lu par le portail).

## 5. Exploitation

- **Ajouter un robot** : Gérer › Ajouter un robot (nom de 1 à 12 caractères : lettres avec accents,
  chiffres, espace, trait d'union, une seule apostrophe ; 12 robots au plus). Il apparaît à l'écran en
  quelques secondes, avec ses liens. Sa couleur vient de son nom ; un nom inconnu reçoit une couleur de
  secours (les couleurs des robots sont dans `public/tv/app.js`).
- **Renommer, réordonner, retirer** : les icônes de la ligne du robot. Retirer un robot arrête ses
  liens tout de suite.
- **Changer le lien d'un robot** (il a fuité, ou on le soupçonne) : « Régénérer le lien » dans la ligne ouverte du robot. L'ancien
  cesse de marcher à l'instant ; il faut donner le nouveau à Grok.
- **Changer la clé de la télé** : « Régénérer la clé ». L'écran du hall affichera 404 jusqu'à ce qu'on
  mette à jour le raccourci du PC.
- **Un robot sans nouvelles depuis 30 minutes** s'affiche au repos. « Besoin d'un humain » tient jusqu'à
  4 heures.
- **Journal d'audit** : les changements de robots et de clés sont enregistrés (`tv.*`), jamais avec une clé.
- **Sauvegarde** : les robots et leurs clés sont dans la base (tables `tv_bots` et `tv_status`), donc dans la
  sauvegarde habituelle de la base (voir `INSTALL.md`). La clé de la télé est dans `integrations`
  (fournisseur `tv`).

## Protéger l'écran (allumé 24 h/24)

Une télé allumée en continu peut garder l'image (rémanence, « burn-in »). Ce que le portail fait :

- **Décalage des pixels** (toujours actif) : toute l'image bouge lentement de quelques pixels (environ 1 % de l'écran, 8 positions en orbite, un pas toutes les 2 minutes), pour qu'aucun élément fixe ne reste au même endroit.
- **Écran au repos hors des heures d'ouverture** (Dashboard TV › Gérer › Protection de l'écran ; heure du Québec ; par défaut lundi au vendredi, 7 h à 18 h) : l'écran devient presque noir avec une petite heure et le logo AKAB très pâles, qui changent de place chaque minute. S'il y a des billets non assignés, un petit chiffre rouge s'ajoute à l'heure (sans clignoter, sans son). « Prévisualiser le repos » montre le résultat dans l'aperçu.
- **Luminosité** : un curseur de 50 à 100 % (90 % par défaut) abaisse l'image affichée.

Ce qu'il faut régler sur la télé elle-même :

- Utiliser la **minuterie marche/arrêt de la télé** pour les heures de fermeture, si elle en a une (le mieux : le rétroéclairage est vraiment éteint).
- Désactiver tout mode « dynamique » ou luminosité maximale, et baisser le rétroéclairage (autour de 60 à 70 %).
- Activer le **décalage de pixels / « screen shift »** de la télé s'il existe (courant sur les OLED).
- Désactiver l'économiseur d'écran ou l'extinction automatique « éco » de la télé s'ils coupent le kiosque pendant les heures d'ouverture.
- Laisser la télé ventilée.

Les télés grand public sont souvent prévues pour moins d'heures par jour que les écrans commerciaux 24/7 : pour un remplacement, choisir un **écran commercial 24/7**.

## Écran technique (télé du département technique)

Une deuxième télé, à part de celle du hall : billets ouverts et en retard, billets non assignés, équipe (qui travaille sur quoi), projets en cours, parc Datto, réseau UniFi et tendance des 7 derniers jours. Elle a **sa propre clé et son propre lien** : Dashboard TV › onglet **Écran technique** (le lien se copie là, la clé se régénère là).

- Adresse : `https://<le portail>/noc/index.html?key=<clé de l'écran technique>` (la clé du hall ne l'ouvre pas, et l'inverse).
- **Clé Fire TV** : ouvrir le navigateur **Silk** (ou une application de kiosque comme **Fully Kiosk Browser**, qui garde la page ouverte, l'écran allumé et recharge après une panne) et aller à l'adresse ; passer en plein écran. La page s'ajuste seule à 1920 x 1080 et se rafraîchit toutes les 30 secondes. Dans les réglages de la Fire TV, désactiver l'économiseur d'écran.
- **Réglages de l'écran** : le repos (jours et heures d'ouverture) et la luminosité sont **les mêmes que ceux de la télé du hall** (Dashboard TV › Gérer › Protection de l'écran). Le décalage de pixels est toujours actif. L'onglet a un bouton « Prévisualiser le repos ».
- Ce que l'adresse laisse voir (elle est lisible depuis Internet avec la clé) : numéros de billet, noms de client, titres abrégés, prénoms des techniciens, totaux. Jamais d'adresse IP, de courriel, de téléphone, de note ni de montant. Les panneaux Datto et UniFi n'apparaissent que si l'intégration est branchée ; si une source tombe en panne, seul son panneau l'indique.
- Si la clé fuite : « Régénérer la clé », puis mettre l'adresse à jour sur la télé.

## 6. Si ça ne marche pas

| Symptôme | À vérifier |
|----------|-----------|
| La télé affiche une page noire ou le portail | l'adresse doit être `/tv/index.html?key=…` avec la bonne clé (404 = clé fausse ou changée) |
| Petite icône « hors ligne » | le PC n'atteint plus le portail (réseau, HTTPS) ; elle disparaît seule au retour |
| L'heure est fausse | rechargement de la page (`Ctrl+F5`) après le déploiement ; l'horloge suit l'heure du Québec quel que soit le PC |
| Tous les robots sont au repos | les rapports datent de plus de 30 minutes, ou aucun lien n'a été ouvert |
| 404 sur un lien de robot | lien régénéré ou robot retiré ; recopier le lien depuis Gérer |
| 429 | trop de requêtes ou de clés fausses depuis la même adresse ; attendre une minute. Derrière un proxy, vérifier `TRUSTED_PROXY_IPS` |
| Le menu « Dashboard TV » est absent | l'utilisateur n'a pas le droit `tv.view` (Admin › Rôles) |
| « Gérer » est absent | il faut le droit `tv.manage` (administrateurs seulement) |

## 7. Retour en arrière

La migration n'ajoute que deux tables. Pour retirer la fonction sans toucher à la base : retirer le droit
`tv.view` aux rôles (le menu disparaît) et couper la télé. Les tables peuvent rester.

## Pas encore vérifié

À regarder en premier après le déploiement : ajouter, renommer et retirer un robot depuis Gérer, la
copie des liens, le bouton plein écran de la page, l'écran sans aucune session (fenêtre privée) et un
vrai rapport venant de Grok. Les tests automatiques couvrent les routes, les clés, les limites et les
tâches approuvées (`tests/tv.test.ts`), pas l'interface.
