<!-- https://cortex-gateway.dev/fr/openclaw-entreprise/ -->

# OpenClaw sur le VPS d'une entreprise : ce que l'auditeur va demander — et quoi ajouter

**En bref**

OpenClaw est d'une honnêteté rare sur son modèle de confiance : une instance gateway est **mono-utilisateur par conception** — sa doc écrit qu'elle n'est « pas une frontière de sécurité multi-tenant » et recommande une instance par personne. Les installateurs la déploient quand même pour des équipes entières : un VPS, un magasin d'identifiants dans `~/.openclaw/`, une allowlist de pairing comme seul portier — et, par défaut, **une session de conversation partagée entre tous les DM**. Cette installation échoue aux quatre questions des audits d'accès, plus une question de cloisonnement des données que les agents type Hermes ne posent même pas. Le correctif n'est pas un-VPS-par-salarié (cela multiplie le problème par vingt) ; c'est une couche d'identité entre OpenClaw et les données de l'entreprise, que son client MCP gère nativement en [trois commandes](/connect/openclaw/).

**Transparence.** Nous maintenons [Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway), une couche d'accès open source qui résout la moitié organisationnelle de cette page. Les faits concernant OpenClaw proviennent de son dépôt et de sa [documentation sécurité](https://docs.openclaw.ai/gateway/security), vérifiés le **17 août 2026**. Corrections bienvenues via une issue GitHub. Même série : [Hermes Agent](/fr/hermes-agent-entreprise/), [Grok Bot](/fr/grok-bot-entreprise/). [This page exists in English.](/answers/openclaw-enterprise-compliance/)

## Pourquoi cette page existe

OpenClaw est l'agent le plus étoilé de GitHub — plus de 385 000 étoiles, licence MIT, natif des messageries, l'assistant personnel qui a banalisé « l'agent always-on sur un VPS à 5 $ ». La même industrie de service qui installe [Hermes pour des entreprises](/fr/hermes-agent-entreprise/) installe OpenClaw pour des entreprises : une instance sur un VPS, branchée à WhatsApp ou Slack, connectée à la messagerie et aux fichiers, toute l'équipe appairée dessus.

La différence : la documentation d'OpenClaw avait déjà dit à l'installateur de ne pas faire ça. Sa page sécurité énonce le modèle de confiance sans ambiguïté et recommande des instances séparées par utilisateur. L'écart que couvre cette page n'est pas caché dans le produit — c'est la distance entre ce que dit la doc et ce qui est déployé.

## Ce qu'OpenClaw sécurise bien — à qui de droit

Pour son périmètre déclaré — une personne et son agent — le travail de sécurité est sérieux :

-   **Hygiène des identifiants** : secrets sous `~/.openclaw/` en permissions `600`/`700` ; les `.env` de workspace ne peuvent pas écraser les identifiants des fournisseurs.
-   **Filtrage entrant** : DM pairing avec codes d'approbation (défaut), allowlists, mention obligatoire et contrôles par groupe, filtres de visibilité du contexte pour les expéditeurs non autorisés.
-   **Politique d'outils et sandboxing** : outils sensibles (`exec`, `browser`, `process`) restreints ou désactivés par défaut ; sandbox Docker/Podman en opt-in ; mode `elevated` réservé au propriétaire.
-   **Auto-audit** : `openclaw security audit` vérifie l'exposition réseau, le rayon d'action des outils, les permissions et les plugins, avec remédiation `--fix`. Plus que ce que livrent la plupart des agents.
-   **Caviardage des logs** : transcripts sur disque avec caviardage des secrets par motifs, extensible via `logging.redactPatterns`.

Tout cela protège *la machine et la surface entrante*. La doc est tout aussi claire sur ce qui est absent : pas d'autorisation par utilisateur (une `sessionKey` « est un sélecteur de routage, pas un jeton d'authentification »), pas d'isolation multi-tenant. Pour une personne, le bon périmètre. Pour une entreprise, toute la question.

## Les quatre questions de l'auditeur — plus une cinquième qu'OpenClaw soulève lui-même

| Question | Instance partagée par défaut | Référence |
| --- | --- | --- |
| **Qui a agi ?** Attribuable à une personne ? | Non — chaque utilisateur appairé agit comme l'instance ; la sessionKey route, elle n'authentifie pas | ISO 27001 A.5.16, SOC 2 CC6.1 |
| **Avec quels droits ?** Moindre privilège par personne ? | Non — un seul magasin `~/.openclaw/` cumule l'union des droits de l'instance | A.5.15, A.8.2, CC6.3 |
| **Journalisé où ?** Piste attribuable et exploitable ? | Transcripts sur disque (caviardés), audit de posture machine — pas de piste par utilisateur, pas d'export | A.8.15, CC7.2 |
| **Révoqué comment ?** Une action pour un partant ? | Désappairer l'utilisateur, puis faire tourner à la main chaque identifiant de l'instance | A.5.18, CC6.2 |
| **Les données sont-elles cloisonnées entre utilisateurs ?** | Par défaut, **non** : tous les DM partagent une session tant que `session.dmScope: "per-channel-peer"` n'est pas configuré — la session d'un salarié peut faire remonter le contexte d'un autre | A.5.15, RGPD art. 5(1)(f), CC6.1 |

La cinquième ligne est propre aux défauts d'OpenClaw, et c'est elle qui transforme un constat de conformité en incident : la fuite de contexte entre salariés ne demande aucun attaquant — seulement deux collègues et la configuration par défaut.

## « Une instance par utilisateur » : honnête — et ça ne passe pas à l'échelle

La réponse documentée d'OpenClaw pour plusieurs utilisateurs : des instances séparées, identifiants isolés, idéalement des comptes OS ou machines séparés. Comme conseil d'isolation, c'est juste. Comme modèle de déploiement d'entreprise, comptez ce que cela crée pour une PME de 20 personnes : vingt instances à patcher, vingt magasins d'identifiants à faire tourner à la moindre fuite, vingt jeux de transcripts à gouverner pour la conservation RGPD — et toujours *zéro* piste d'audit centrale, *zéro* révocation unique, et des systèmes en aval qui voient vingt comptes de service au lieu de vingt personnes.

L'isolation entre utilisateurs est nécessaire. Ce n'est pas la même chose que le contrôle d'accès organisationnel, et multiplier les instances achète la première en laissant le second intact.

## L'angle RGPD

**Les transcripts sont des données personnelles.** Les transcripts de session persistent sur disque — conversations de salariés et de clients comprises. Le caviardage attrape les secrets, pas les données personnelles ; conservation et effacement (art. 5(1)(e), art. 17) restent à la charge de l'opérateur.

**Art. 32** : identifiants partagés, session partagée par défaut et absence de journal d'accès sur une machine qui lit la messagerie de l'entreprise — une position difficile dans un rapport d'incident ; le seul défaut de session partagée est un constat d'intégrité-confidentialité (art. 5(1)(f)).

**Art. 30** : des tâches sans surveillance sur des données clients sont des activités de traitement ; quelqu'un doit pouvoir les lister.

**L'art. 28 retombe sur l'installateur.** Celui qui continue d'opérer le VPS — mises à jour, redémarrages, SSH — est un sous-traitant et doit un DPA. C'est la clause que la plupart des installateurs découvrent après coup, et c'est leur responsabilité qu'elle engage, pas celle du client.

## Le correctif garde OpenClaw

Gardez le runtime — les skills, les canaux, le sandboxing, une instance par utilisateur si vous suivez la doc. Déplacez *l'accès aux données de l'entreprise* derrière une couche d'identité qu'OpenClaw parle déjà. Son client MCP gère le Streamable HTTP avec tokens OAuth managés (v1.5.0+) : [trois commandes](/connect/openclaw/), et l'agent détient un token court lié à une personne réelle au lieu de clés API brutes éparpillées dans sa config.

-   **Chaque salarié s'authentifie comme lui-même** — ses appels OpenClaw portent *son* identité ; chaque application applique les permissions que cette personne a déjà. La [couche de permission](/answers/agent-permission-layer/), pas une clé partagée.
-   **Le moindre privilège devient des scopes**, par utilisateur, revus quand les rôles changent.
-   **Chaque appel d'outil écrit une ligne d'audit attribuable**, sur votre infrastructure, exportable.
-   **La révocation est un acte unique** — couper le grant OAuth coupe tous les backends, tâches sans surveillance comprises.

Les clés des fournisseurs de modèles peuvent rester locales ; elles authentifient l'agent auprès de son cerveau, pas auprès de votre métier. La checklist installateur en cinq points et le mapping contrôles → référentiels sont les mêmes que pour Hermes : voir [la checklist de l'installateur](/fr/hermes-agent-entreprise/) et [AI agent compliance controls](/answers/ai-agent-compliance-controls/) (en anglais). Et quoi que vous changiez, lancez `openclaw security audit --fix` — la moitié machine reste à durcir par vos soins.

[Connecter OpenClaw à une gateway — trois commandes →](/connect/openclaw/)

## FAQ

### OpenClaw est-il multi-utilisateurs ?

Non — sa doc écrit qu'une instance gateway n'est « pas une frontière de sécurité multi-tenant » et recommande une instance par personne. Pairing et allowlists filtrent qui peut lui parler, mais toute personne admise agit via le même magasin d'identifiants, et par défaut tous les DM partagent une session.

### OpenClaw a-t-il une piste d'audit ?

Des transcripts sur disque avec caviardage des secrets, plus un `security audit` de posture machine — mais aucune piste attribuable par utilisateur : une sessionKey route, elle n'authentifie pas. Les systèmes en aval enregistrent l'instance, pas la personne. L'attribution doit être ajoutée à la couche d'accès.

### Une équipe peut-elle partager une instance sur un VPS ?

La doc le déconseille. Identifiants partagés cumulant l'union des droits, aucune attribution — et tant que `session.dmScope` n'est pas modifié, un contexte de conversation partagé où la session d'un salarié peut faire remonter celle d'un autre. Compte de service partagé et défaut de cloisonnement, dans la même installation.

### Une instance par salarié, est-ce viable ?

C'est la réponse documentée, honnête — et elle multiplie au lieu de résoudre : N instances à patcher, N magasins d'identifiants, N jeux de transcripts, toujours pas d'audit central ni de révocation unique. Gardez l'instance par utilisateur côté runtime ; placez l'accès aux données de l'entreprise derrière une gateway OAuth 2.1 unique.

### Que doit ajouter un installateur pour un déploiement en entreprise ?

Une identité OAuth 2.1 par utilisateur pour les outils métier (OpenClaw gère l'OAuth managé depuis la v1.5.0), des scopes de moindre privilège, une piste d'audit exportable par appel, une révocation centrale testée, et la paperasse — DPA (art. 28), registre des traitements, réponse conservation pour les transcripts. Plus `openclaw security audit --fix` pour la moitié machine.
