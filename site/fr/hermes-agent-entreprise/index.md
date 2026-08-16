<!-- https://cortex-gateway.dev/fr/hermes-agent-entreprise/ -->

# Hermes Agent sur le VPS d'une entreprise : ce que l'auditeur va demander — et quoi ajouter

**En bref**

Le modèle de sécurité d'Hermes Agent est **réellement bon à la frontière de la machine** — approbation des commandes, blocklist inconditionnelle, isolation par containers, protection des magasins d'identifiants. Il est **absent à la frontière de l'organisation, ouvertement et par conception** : sa documentation vise les individus et les petites équipes. Sur le « VPS à 5 $ » que son propre README suggère, cet écart est invisible pour une personne seule et rédhibitoire pour une entreprise : tous les utilisateurs autorisés agissent via les mêmes clés API, rien n'attribue une action à une personne, et il n'existe ni piste d'audit ni révocation centrale. Les auditeurs posent exactement quatre questions auxquelles l'installation par défaut ne sait pas répondre. Le correctif n'est pas de remplacer Hermes — c'est de placer une couche d'identité entre Hermes et les données de l'entreprise, ce qu'Hermes sait faire nativement en [deux lignes de YAML](/connect/hermes/).

**Transparence.** Nous maintenons [Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway), une couche d'accès open source qui résout la moitié organisationnelle de cette page. Les faits concernant Hermes Agent proviennent de son dépôt et de sa [documentation sécurité](https://hermes-agent.nousresearch.com/docs/user-guide/security), vérifiés le **16 août 2026**. Corrections bienvenues via une issue GitHub. [This page exists in English.](/answers/hermes-agent-enterprise-compliance/)

## Pourquoi cette page existe

Hermes Agent (Nous Research) est l'agent phénomène de 2026 — plus de 230 000 étoiles GitHub, natif des messageries, avec un planificateur intégré qui exécute des tâches sans surveillance. Toute une activité de service s'est construite autour : des installateurs déploient Hermes sur un VPS pour des TPE et PME, branché à Telegram ou Slack, connecté à la messagerie, au CRM et aux fichiers de l'entreprise. L'installation tient dans une après-midi et la démo fait mouche à chaque fois.

Puis quelqu'un — le prestataire informatique d'un client, le questionnaire d'un assureur, une due diligence, un DPO — demande comment l'accès est contrôlé. La réponse honnête sur l'installation par défaut : par une allowlist de plateforme, devant un jeu de clés partagées, sans journal de qui a fait quoi. Cette page s'adresse à l'installateur qui veut une meilleure réponse, et à l'entreprise qui pose la question.

## Ce qu'Hermes sécurise bien — à qui de droit

Sa [documentation sécurité](https://hermes-agent.nousresearch.com/docs/user-guide/security) est plus sérieuse que la moyenne de la catégorie :

-   **Approbation des commandes** à trois modes, et une blocklist inconditionnelle des commandes catastrophiques qui reste active *même en mode `--yolo`*.
-   **Isolation par containers** bien faite : `--cap-drop ALL`, `no-new-privileges`, limites de processus, tmpfs.
-   **Hygiène des identifiants sur la machine** : clés dans `~/.hermes/.env` en `chmod 600`, écritures bloquées vers `~/.ssh/` et les magasins d'identifiants, filtrage d'environnement pour les sous-processus MCP, caviardage des tokens dans les messages d'erreur.
-   **Défenses contre les entrées hostiles** : prévention SSRF, détection d'injection de prompt dans les fichiers de contexte, alertes supply chain.

Tout cela protège *la machine contre l'agent et l'agent contre les entrées hostiles*. Rien de cela ne répond aux questions *organisationnelles* — qui peut faire quoi, en tant que qui, journalisé où. Ce sont des problèmes différents, et la doc d'Hermes ne prétend pas le contraire : le contrôle d'accès multi-utilisateurs se résume à une allowlist de plateforme plus un DM pairing, et aucune piste d'audit par utilisateur ni RBAC n'est décrite. Pour son public déclaré — une personne et son agent — c'est le bon périmètre.

## Les quatre questions de l'auditeur

Que le référentiel soit l'ISO 27001, SOC 2 ou le questionnaire d'un assureur, l'accès automatisé reçoit toujours les quatre mêmes questions. Voici ce que répond l'installation VPS par défaut, et le contrôle correspondant :

| Question | Installation VPS par défaut | Référence |
| --- | --- | --- |
| **Qui a agi ?** Chaque action est-elle attribuable à une personne ? | Non — chaque utilisateur de l'allowlist agit comme la même instance ; les systèmes en aval voient le compte de l'instance | ISO 27001 A.5.16, SOC 2 CC6.1 |
| **Avec quels droits ?** Moindre privilège par personne ? | Non — un seul jeu de clés `~/.hermes/.env` cumule l'union des droits de tous | A.5.15, A.8.2, CC6.3 |
| **Journalisé où ?** Une piste attribuable et exploitable ? | État de session local ; pas de journal par utilisateur, pas d'export | A.8.15, CC7.2 |
| **Révoqué comment ?** Une seule action pour couper un partant ? | Faire tourner à la main chaque clé que l'instance détient — en espérant qu'aucune n'a été copiée | A.5.18, CC6.2 |

Notez ce qui *n'est pas* dans cette liste : rien sur le modèle, l'injection de prompt ou les containers. Hermes couvre déjà cela mieux que la plupart. Les audits recalent les déploiements sur la moitié ennuyeuse.

## L'angle RGPD — plus tranchant que ne l'imaginent la plupart des installateurs

**La mémoire de l'agent est une donnée personnelle.** L'argument phare d'Hermes est la persistance : il recherche dans ses conversations passées et « construit un modèle de plus en plus fin de qui vous êtes au fil des sessions ». Sur le VPS d'une entreprise, c'est un stock croissant de données personnelles de salariés et de clients, sans réponse documentée sur la conservation ni l'effacement — l'opérateur doit la fournir (art. 5(1)(e), art. 17).

**L'art. 32** exige des mesures de sécurité adaptées au traitement — des identifiants partagés et l'absence de journaux d'accès sur une machine qui lit la messagerie de l'entreprise sont une position difficile à défendre dans un rapport d'incident.

**L'art. 30** exige un registre des activités de traitement. Un planificateur qui exécute sans surveillance des tâches en langage naturel sur des données clients, c'est du traitement ; quelqu'un doit pouvoir dire lequel.

**L'art. 28 est celui qui retombe personnellement sur l'installateur.** Un installateur qui continue d'opérer le VPS — mises à jour, redémarrages, accès SSH à une machine qui traite les données clients de son client — est un *sous-traitant* au sens du RGPD, et il lui faut un contrat de sous-traitance (DPA) qui le dit. Installer un agent chez un client sans ce contrat, c'est porter la responsabilité gratuitement.

## Le correctif garde Hermes

Rien de ce qui précède ne plaide pour un autre agent. Cela plaide pour une **séparation des couches** : Hermes reste le runtime — les skills, le planificateur, les messageries — et l'accès aux données de l'entreprise passe derrière une couche d'identité qu'il sait déjà utiliser.

Hermes embarque un client MCP OAuth 2.1 complet : enregistrement dynamique du client, PKCE, rafraîchissement des tokens. Pointé vers une gateway MCP protégée par OAuth, le déploiement change entièrement de forme :

-   **Chaque salarié s'authentifie comme lui-même** — le parcours navigateur, une fois. Ses appels Hermes portent *son* identité ; chaque application applique les permissions que cette personne a déjà. La [couche de permission](/answers/agent-permission-layer/), au lieu d'une clé partagée.
-   **Le moindre privilège devient des scopes**, accordés par utilisateur — pas l'union de tout ce que l'instance a jamais reçu.
-   **Chaque appel d'outil écrit une ligne d'audit attribuable**, sur votre infrastructure, exportable pour qui la demande.
-   **La révocation est un acte unique** : couper le grant OAuth coupe tous les backends d'un coup — y compris pour les tâches sans surveillance du planificateur.

Les clés des fournisseurs de modèles peuvent rester dans `~/.hermes/.env` ; elles authentifient l'agent auprès de son cerveau, pas auprès de votre métier. C'est *l'accès aux données de l'entreprise* qui ne doit jamais reposer sur des identifiants statiques partagés. Côté Hermes, la configuration est la plus courte de tous les clients que nous documentons : [deux lignes de YAML](/connect/hermes/).

## La checklist de l'installateur

Ce qui sépare « j'ai installé un agent » de « j'ai déployé de l'automatisation gouvernée » — la version qui survit au prochain audit du client :

1.  **Identité par utilisateur** pour chaque outil métier (OAuth 2.1 devant les données de l'entreprise ; aucune clé API partagée au-delà du fournisseur de modèle).
2.  **Scopes de moindre privilège** par salarié, revus quand les rôles changent.
3.  **Piste d'audit attribuable**, par appel, exportable — testez que vous savez répondre à « qu'a fait l'agent en tant qu'Alice mardi dernier ? »
4.  **Révocation centrale**, testée : désactivez un utilisateur en une action, vérifiez que les tâches du planificateur perdent aussi l'accès.
5.  **La paperasse** : un DPA si vous opérez le VPS, un registre des traitements pour les tâches de l'agent, et une réponse conservation/effacement pour la mémoire persistante d'Hermes.

Le mapping contrôles → référentiels — ISO 27001:2022 Annexe A, SOC 2 CC6/CC7, et pourquoi l'AI Act européen ne s'applique probablement pas à un agent interne — est sur [AI agent compliance controls](/answers/ai-agent-compliance-controls/) (en anglais). Le versant menaces (tool poisoning, rug pulls, détournement de session) est sur [MCP security best practices](/answers/mcp-security-best-practices/).

[Connecter Hermes à une gateway — deux lignes de YAML →](/connect/hermes/)

## FAQ

### Hermes Agent est-il conforme au RGPD ?

Un logiciel n'est jamais conforme au RGPD en soi — ce sont les déploiements qui le sont. Une installation en entreprise soulève l'art. 32 (mesures de sécurité : qui accède à l'instance, avec quels droits), l'art. 30 (registre de ce que l'agent traite), la conservation et l'effacement de la mémoire persistante d'Hermes — qui est une donnée personnelle — et l'art. 28 : l'installateur qui continue d'opérer le VPS est un sous-traitant et doit signer un DPA. Rien de tout cela n'est la faute d'Hermes ; tout est à la charge de l'opérateur.

### Hermes Agent a-t-il une piste d'audit ?

Pas au sens de l'auditeur, en date d'août 2026 : l'état de session est local, et la documentation sécurité ne décrit ni journal attribuable par utilisateur, ni RBAC, ni export SIEM. Comme tous les utilisateurs autorisés passent par un seul jeu d'identifiants, les systèmes en aval enregistrent l'instance, pas la personne. L'attribution doit être ajoutée à la couche d'accès, là où chaque appel porte une identité réelle.

### Plusieurs salariés peuvent-ils partager un Hermes sur un VPS ?

Techniquement oui — allowlists et DM pairing filtrent qui peut lui parler. Mais toute personne admise agit via les mêmes clés `~/.hermes/.env`, cumulant l'union des droits accordés, sans attribution, avec une mémoire partagée. C'est le schéma du compte de service partagé que les audits existent pour détecter. La forme multi-utilisateurs doit venir d'une couche d'identité devant les outils.

### Hermes est-il certifié ISO 27001 ou SOC 2 ?

Les certifications s'appliquent aux organisations, pas aux logiciels open source — la question est mal posée pour Hermes comme pour tout framework. La vraie question : *votre déploiement* passe-t-il *votre* audit ? A.5.15–A.5.18, A.8.15, CC6/CC7 portent sur l'authentification de l'agent auprès des systèmes de l'entreprise, l'attribution des actions à des personnes et la révocation centralisée.

### Que doit ajouter un installateur pour un déploiement en entreprise ?

Une identité OAuth par utilisateur pour les outils métier, des scopes de moindre privilège, une piste d'audit exportable par appel, une révocation centrale testée, et la paperasse (DPA, registre des traitements, réponse conservation pour la mémoire de l'agent). Les clés de modèles peuvent rester dans `.env` — c'est l'accès aux données de l'entreprise qui ne doit pas reposer sur des identifiants statiques partagés.
