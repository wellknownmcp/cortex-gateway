<!-- https://cortex-gateway.dev/fr/grok-bot-entreprise/ -->

# Grok Bot dans votre entreprise : ce que la DSI, l'auditeur et le RGPD vont demander

**En bref**

Grok Bot (xAI/SpaceXAI, bêta depuis le 11 août 2026) donne à chaque utilisateur des agents always-on sur un **VM Linux cloud qui se connecte aux applications avec les identifiants du salarié** — comme un humain, y compris sur les outils sans API. C'est l'argument de vente, et c'est aussi la surface de conformité : des connexions depuis un VM de datacenter hors de votre périmètre device-trust (les docs de xAI le disent), une **vue d'audit des actions qui n'existe pas encore**, un kill qui **conserve le stockage persistant**, et des systèmes en aval incapables de distinguer le salarié de son bot. Contrairement aux cas [Hermes](/fr/hermes-agent-entreprise/) et [OpenClaw](/fr/openclaw-entreprise/), ce n'est pas une erreur d'installateur — c'est le produit qui fonctionne comme prévu, accessible via un abonnement *grand public* que votre DSI ne voit jamais. La voie gouvernable existe et les docs de xAI la désignent elles-mêmes : **Grok Bot hérite de la politique MCP de votre équipe** — placez donc les outils de l'entreprise derrière une gateway MCP OAuth 2.1 et faites de cette voie celle que le bot emprunte.

**Transparence.** Nous maintenons [Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway), une couche d'accès open source pertinente pour le correctif ci-dessous. Les faits concernant Grok Bot proviennent de l'[annonce de xAI](https://x.ai/news/introducing-grok-bot) et de sa [documentation équipes & entreprises](https://docs.x.ai/grok-bot/teams-and-enterprises), vérifiées le **17 août 2026**. Grok Bot est en bêta et l'accès entreprise sur liste d'attente — les détails changeront ; corrections bienvenues via une issue GitHub. Même série pour [Hermes Agent](/fr/hermes-agent-entreprise/) et [OpenClaw](/fr/openclaw-entreprise/). [This page exists in English.](/answers/grok-bot-enterprise-compliance/)

## Ce qu'est Grok Bot — et pourquoi l'argument de vente est le risque

Grok Bot, c'est une équipe d'agents always-on, chacun travaillant sur un ordinateur cloud persistant, disponible pour les abonnés SuperGrok Heavy, Cursor Ultra et Cursor Teams Premium. Son différenciateur est précisément ce qui rend la gouvernance difficile : un bot *navigue, clique et tape dans les champs comme un humain*, en se connectant aux outils que le salarié utilise déjà avec ses propres identifiants — y compris les « logiciels d'entreprise legacy » *sans API ni MCP propre*. Il continue de travailler laptop éteint, et les bots se coordonnent entre eux en group chat.

Hermes et OpenClaw posent des questions de VPS parce que des installateurs les déploient mal. Grok Bot les pose *par conception* : la gestion des identifiants, l'exécution sans supervision et la résidence cloud sont le produit. Les questions ci-dessous s'adressent donc à la DSI et au RSSI, pas aux installateurs.

## Ce que xAI a bien fait — à qui de droit

-   **Un ordinateur par membre**, que les admins peuvent inspecter et supprimer ; les membres peuvent se réinitialiser eux-mêmes.
-   **Les clés matérielles survivent** : les invites WebAuthn sont relayées vers l'application desktop du membre — les facteurs anti-phishing ne sont pas simplement cassés.
-   **MCP fait proprement** : Grok Bot hérite de la configuration MCP existante de l'équipe et de sa politique allowlist/denylist, et les tokens des serveurs MCP hébergés *restent côté backend Cursor, pas stockés sur l'ordinateur*.
-   **Des contrôles au niveau organisation** pour les admins Cursor Teams : désactivation totale de Grok Bot, contrôle du lancement d'agents cloud, règles d'équipe ; le Privacy Mode (Legacy) le bloque entièrement.
-   **L'entraînement suit les réglages de confidentialité de l'équipe**, comme pour Cursor.

Ce sont de vrais contrôles. Les constats ci-dessous portent sur ce qu'ils ne couvrent pas encore — souvent énoncé par la documentation de xAI elle-même.

## La grille d'audit, appliquée

| Question | Grok Bot aujourd'hui (docs xAI, août 2026) | Référence |
| --- | --- | --- |
| **Qui a agi ?** | Ambigu par construction : le bot se connecte en tant que salarié ; les systèmes en aval ne distinguent pas la personne de son bot always-on | ISO 27001 A.5.16, SOC 2 CC6.1 |
| **Avec quels droits ?** | Tous ceux du salarié — une connexion par mot de passe ne se scope pas ; le moindre privilège est structurellement indisponible dans cette voie | A.5.15, A.8.2, CC6.3 |
| **Journalisé où ?** | Consommation et usage ; « une vue d'audit des actions des bots arrive » — donc pas aujourd'hui | A.8.15, CC7.2 |
| **Révoqué comment ?** | Tuer le VM (« le stockage persistant est conservé ») puis faire tourner à la main chaque mot de passe utilisé par le bot | A.5.18, CC6.2 |
| **Dans le périmètre de sécurité ?** | Non — les connexions partent d'un VM de datacenter ; « agents de device-trust non disponibles nativement » : l'accès conditionnel est contourné, ou affaibli pour laisser entrer le bot | A.8.1, CC6.6 |

La cinquième ligne mérite l'accent parce qu'elle est auto-infligée dès le premier jour : une organisation qui applique le device-trust soit bloque les bots (et les utilisateurs contournent la DSI), soit perce une exception pour un VM cloud qu'elle n'administre pas. Les deux issues se retrouvent dans le prochain audit.

## Le multiplicateur shadow IT

Tout ce qui précède suppose que l'entreprise sait que les bots existent. Or Grok Bot est aussi vendu via **SuperGrok Heavy — un abonnement grand public**. Un salarié peut créer un bot sur un compte personnel, lui confier ses identifiants professionnels, et produire un travailleur fantôme always-on dont la DSI n'a jamais entendu parler, exerçant des identifiants d'entreprise depuis un VM non administré. L'accès entreprise est sur liste d'attente ; l'accès personnel ne l'est pas. Les seuls leviers : la politique interne, la détection (alertes impossible-travel et connexions depuis des IP de datacenter), et une alternative approuvée — une interdiction sans voie officielle est exactement ce qui fait proliférer la version compte-personnel.

## L'angle RGPD

**Tout ce que le bot voit transite et persiste sur le VM cloud d'un fournisseur américain.** Écrans, documents, boîtes mail — un traitement de données personnelles de salariés et de clients sur l'infrastructure xAI/Cursor, à inventorier au titre de l'art. 30 et à évaluer au titre du chapitre V (transferts). La documentation Grok Bot consultée ne dit rien de la résidence des données, d'un DPA ou d'un SOC 2 pour ce produit ; tant que l'offre entreprise n'a pas publié ses conditions, cette absence *est* la réponse à consigner dans l'AIPD.

**« Le stockage persistant est conservé. »** Tuer un bot supprime le VM mais pas son stockage persistant — une question de conservation et d'effacement (art. 5(1)(e), art. 17) sans chemin de suppression documenté à ce jour.

**L'entraînement suit les réglages de confidentialité de l'équipe** — donc, pour un usage via abonnement personnel, ceux de l'individu. Une AIPD pour l'usage autorisé, et l'hypothèse d'un usage non autorisé, se justifient toutes deux (art. 35, art. 32).

## Le correctif : faire de la voie MCP la seule voie pour les données de l'entreprise

Le plus remarquable dans la documentation de xAI : le chemin gouverné est déjà câblé — **Grok Bot suit la politique MCP de votre équipe** (allowlists, denylists, authentification MCP partagée avec Cursor, tokens des serveurs hébergés gardés hors du VM). La voie navigateur-identifiants et la voie MCP coexistent ; gouverner, c'est déplacer les données de l'entreprise vers la seconde :

-   **Exposez les outils de l'entreprise comme serveurs MCP derrière une gateway OAuth 2.1 unique** — [un contrat d'environ 120 lignes par application](/guides/rest-api-to-mcp-server/), ou [un backend d'intégration](/guides/github-app-mcp-backend/) pour les API tierces. Allowlistez la gateway dans la politique MCP de l'équipe ; denylistez le reste.
-   **Le bot de chaque salarié agit alors sur un grant OAuth scopé, par utilisateur**, pas sur ses mots de passe : le moindre privilège devient des [scopes](/answers/agent-permission-layer/), et les actions du bot deviennent distinguables de celles de l'humain — l'attribution que la vue d'audit « à venir » ne fournira pas.
-   **Chaque appel écrit une ligne d'audit attribuable** sur votre infrastructure — sans attendre la roadmap d'un fournisseur pour l'A.8.15.
-   **La révocation redevient un acte unique** : coupez le grant, et l'accès du bot à chaque backend meurt avec — pas de chasse aux mots de passe, quoi que le stockage persistant ait gardé.

Ce qui reste dans la voie navigateur — les outils legacy sans API — reste ingouvernable par construction ; ce résidu est une décision d'acceptation du risque à écrire noir sur blanc, pas un détail à découvrir en incident. Le mapping contrôles → référentiels est sur [AI agent compliance controls](/answers/ai-agent-compliance-controls/) (en anglais) ; le versant menaces sur [MCP security best practices](/answers/mcp-security-best-practices/).

[Placer une gateway OAuth 2.1 devant vos outils →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### Grok Bot est-il sûr avec les outils de l'entreprise ?

Selon la voie. La voie navigateur — le bot se connectant avec les identifiants du salarié depuis son VM cloud — contourne le device-trust, n'a pas d'audit par action aujourd'hui, et porte tous les droits du salarié sans supervision. La voie MCP hérite de la politique allowlist de l'équipe et garde les tokens hors du VM. Les données de l'entreprise appartiennent à la seconde.

### Où vivent les identifiants utilisés par Grok Bot ?

Les connexions se font dans le VM Linux du bot ; WebAuthn est relayé vers le desktop du membre, et xAI recommande des passkeys dans un gestionnaire de mots de passe pour la ré-authentification — des identifiants professionnels exercés et stockés sur un VM hors de votre périmètre. Les tokens des serveurs MCP hébergés, eux, « restent côté backend Cursor ».

### Grok Bot a-t-il une piste d'audit ?

Pas encore — analytics d'usage aujourd'hui, « une vue d'audit des actions arrive » selon les docs. Et comme le bot agit en tant que salarié, les journaux en aval ne séparent pas la personne du bot ; il faut que l'accès du bot soit identifié séparément, ce que fournissent des scopes OAuth par utilisateur.

### La DSI peut-elle le contrôler ou le bloquer ?

Avec Cursor Teams : désactivation organisation, contrôle des agents cloud, règles d'équipe, allowlists MCP, inspection/suppression des ordinateurs ; le Privacy Mode (Legacy) le bloque entièrement. Le trou : SuperGrok Heavy est un abonnement grand public — les bots sur compte personnel avec des identifiants professionnels sont un problème de shadow IT qu'aucun réglage d'équipe n'atteint.

### Comment révoquer l'accès d'un bot au départ d'un salarié ?

Supprimer l'ordinateur du membre — « Kill supprime la machine virtuelle. Le stockage persistant est conservé. » Puis faire tourner chaque mot de passe que le bot utilisait, car tuer le VM n'en invalide aucun. Un grant OAuth derrière une gateway se révoque en un acte ; cette différence est tout l'argument.
