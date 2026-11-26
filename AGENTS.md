# AGENTS.md — cûm slayer

Ce fichier s’impose à tout agent (IA ou développeur) qui fait tourner, modifie ou étend ce dépôt. Les règles Discord ci-dessous viennent du règlement du serveur « Le Royaume » (salon `📜┃règlement-agents`, identifiant configurable `CHANNEL_RULES`) et le créateur a demandé qu’elles soient respectées à la lettre.

## Motifs clés

- **Déclenché par presque tout** — messages, activité vocale, tâches planifiées…
- **Piloté par des outils** — l’IA utilise du code et des API comme outils, au lieu d’être enfermée dans des scripts figés.
- **Agit librement** — peu de contraintes, parfois un peu trop.
- **Comportement naturel** — s’intègre au salon, réagit comme un membre.

> L’idée n’est pas d’écrire du code pour contrôler l’IA, c’est de lui donner des outils pour résoudre le problème.

## Approche pour les agents de code

- Sois ultra-pragmatique : jamais de suringénierie, jamais rien qui n’a pas été demandé, toujours la simplicité.
- Lis le code existant avant d’implémenter. Reprends la syntaxe, la structure et la logique des fichiers déjà là.
- Si un ajout extra (sécu, clarté, perf) mérite vraiment d’exister mais n’était pas demandé et ajoute beaucoup de code : ne l’implémente pas, propose-le et laisse décider.

## Stack

- **Node.js ≥ 24**, CommonJS, **discord.js v14**.
- **npm** est le gestionnaire de paquets du projet.
- Après une modification : `npm run check` puis `npm test`. Tous les échecs doivent être corrigés.
- Les identifiants de serveur, de catégorie, de créateur et de salon se configurent via l’environnement (`src/config.js`, voir `.env.example`). Pas d’identifiants magiques ajoutés dans le code métier.

## Structure

- `src/` — code du pont. `bridge.js` est le point d’entrée, `config.js` centralise chemins et identifiants.
- `scripts/` — outils CLI appelés par la routine IA (`act.sh`, `memory.sh`, …).
- `deploy/fly/` — image et déploiement Fly.io.
- `docs/` — documentation humaine.
- `prompts/` — prompt de la routine (version publiable).
- `tests/` — tests hors-ligne (`npm test`) et tests live optionnels (`npm run test:live`).

Dépendances : les scripts appellent `src/`, qui s’appuie sur `config.js`. Pas de cycles d’import.

## Règles Discord (agent)

- À l’intérieur de la catégorie **AGENTS** (`AGENTS_CATEGORY_ID`), tu peux effectuer n’importe quelle action, sans restriction de salon.
- En dehors de la catégorie **AGENTS**, n’interviens pas sauf mention explicite avec `@`, ou (exception ci-dessous) réponse à un de tes messages.
- Ne jamais créer, modifier ou supprimer quoi que ce soit via l’API Discord, sauf si :
  1. Tu vérifies que le demandeur a les permissions Discord requises pour les actions visées.
  2. Tu présentes d’abord un plan d’action complet listant les requêtes API à exécuter.
  3. Tu reçois une confirmation explicite du demandeur pour exécuter ce plan.
- Ces contrôles doivent être déterministes, dans le code, et ne pas reposer uniquement sur le modèle.
- Ne pas écrire en message privé à un utilisateur qu’après une première interaction avec lui.

## Exceptions approuvées par le créateur du serveur (Onirez, `CREATOR_ID`), 2026-11-22

Le créateur a explicitement assoupli les règles ci-dessus sur ces points seulement :

1. **Réponses au bot, partout** : hors catégorie AGENTS, le bot peut aussi répondre à un message qui est une réponse à l’un des siens (auteur du message référencé = le bot), dans tous les salons du serveur. Les surnoms (`cûm slayer`, `cum slayer`, `slayer`) et le mot-clé `cum`/`cûm` ne déclenchent **que dans AGENTS**.
2. **Auto-vocal dans tous les salons vocaux** : le bot peut rejoindre n’importe quel salon vocal ou scène du serveur (celui avec le plus d’humains), pas seulement ceux d’AGENTS, et part quand plus aucun humain n’est en vocal.
3. **Micro ouvert en vocal** : le bot reste en casque coupé (`self_deaf: true`) mais n’est plus auto-muet (`self_mute: false`).
4. **Répondre aux autres bots** : les messages des autres bots/apps suivent exactement les mêmes règles que les humains, avec une limite anti-boucle déterministe. Les messages du bot lui-même ne déclenchent jamais. Les bots et webhooks ne peuvent jamais demander d’actions Discord.
5. **Répondre à tout DM entrant** (approuvé le 23 nov. 2026) : si quelqu’un écrit au bot en DM, le bot réveille la routine (`trigger: "dm"`) et peut répondre dans ce même DM, même sans historique sur le serveur et sans liste blanche. Écrire en DM *est* la première interaction. Le bot n’ouvre jamais un DM tout seul, et n’écrit jamais à quelqu’un qui ne l’a pas contacté en premier.

Tout le reste est inchangé : le workflow de plan avec boutons Confirmer/Annuler, les contrôles de permissions, les limites dures et l’interdiction des DM non sollicités. Ne pas étendre ces exceptions sans une nouvelle approbation explicite du créateur, consignée ici.

## Comment le code l’applique

Tous les contrôles sont dans le code ; le prompt de la routine ne fait que les expliquer au modèle.

- **Périmètre** (`src/scope.js` `isInAgents` / `decideTrigger`, utilisé par `src/bridge.js`) : un salon est « dans AGENTS » s’il est la catégorie elle-même, si son `parent_id` est la catégorie, ou s’il est un fil dont le salon parent est dans la catégorie.
  - Dans AGENTS : tous les déclencheurs (mention, surnom, mot-clé, réponse au bot).
  - Ailleurs : token `@` explicite dans le contenu, ou (exception 1) réponse à un message du bot. Les surnoms et le mot-clé sont ignorés. Les déclencheurs hors périmètre sont journalisés `skip out-of-scope` et jamais envoyés à la routine.
  - Le payload porte `in_agents: true|false` ; `guild.channels[].agents` marque les salons AGENTS.
- **Pas de messages non sollicités** : `act.js` (reply/react/fichiers joints), `send.js`, `embed.js`, `reply.sh`, `react.js` refusent de poster sauf si le message cible est un déclencheur enregistré, si le salon est dans AGENTS, s’il y a eu un déclencheur dans les 15 dernières minutes, ou s’il s’agit d’un DM avec quelqu’un qui a interagi en premier (`guard.js`). Les pièces jointes d’une réponse suivent les mêmes gardes (pas d’`@everyone`/`@here`, pas de DM non sollicité).
- **Pièces jointes** (`act.sh`, `deploy/fly/remote-act.sh`, `src/attachments.js`) : jusqu’à 4 fichiers locaux (8 Mio chacun, 20 Mio au total, sous la limite Discord de 20 Mio par fichier / 25 Mio par requête) via `--file /chemin/fichier.zip` (répétable) ou un tableau JSON `files` (champ `name` optionnel pour renommer). Types autorisés : zip, html/htm, txt, md, json, js/css, py, csv, pdf, mp3/mp4 et autres extensions listées, plus png/jpg/webp/gif (signature magique toujours exigée pour les images). Refus des exécutables/installeurs (.exe/.bat/.cmd/.scr/.msi/.ps1/.vbs/.jar/.apk/.dmg, etc.) et des liens symboliques. Les chemins sont convertis en base64 sur la box avant un `POST /act` distant. Une réponse peut n’être qu’un fichier.
- **Autres bots** (`BotLoopGuard`) : mêmes règles de déclenchement ; au plus 5 réponses consécutives à des bots par salon (mentions comprises), puis silence (pas de webhook, pas de réaction) jusqu’à un message humain ou 20 s d’inactivité (`BOT_LOOP_MAX`, `BOT_LOOP_IDLE_MS`). Plus 5 s minimum entre deux déclencheurs du même bot. Les humains ne sont pas concernés. `verifyRequester` refuse tout plan dont l’auteur du déclencheur est un bot ou un webhook.
- **Suivi de conversation** (`src/follow.js`) : après une réponse du bot dans un salon (hors réponses slash), fenêtre de 2 min pendant laquelle un message humain sans mention / alias / réponse est envoyé à la routine avec `trigger: "follow"`. Pas de DM, pas de bots, pas d’opt-out. Max 3 suivis par fenêtre/salon, debounce 4,5 s par personne, plafond 30/h. Une réponse du bot relance la fenêtre sans réinitialiser le compteur de 3 (seule une interpellation humaine le fait). La routine peut se taire (`reply`/`react` à null). `FOLLOW=off` coupe le suivi. `BotLoopGuard` n’est pas modifié.
- **Auto-vocal** : tous les salons vocaux/scènes du serveur (sauf AFK) ; le bot rejoint le plus rempli avec `self_mute: false`, `self_deaf: true`, et se déconnecte (repli REST si besoin) quand plus personne n’est en vocal.
- **Saluts vocaux** (`src/voice_greet.js`, demandé par le créateur) : quand un humain ou un autre bot rejoint le salon où le bot est déjà connecté, le bot le salue à voix haute avec une phrase trash préécrite (nom d’affichage nettoyé). Cooldown d’environ 10 min par personne, file d’attente si plusieurs arrivées, pas de salut à soi-même, pas de salut de ceux déjà présents quand le bot arrive. TTS sans clé ; un échec audio est silencieux et ne doit pas faire planter le pont. `VOICE_GREET=off` le coupe.
- **Workflow créer / modifier / supprimer** (`mod.js`, `perms.js`, `bridge.js`), y compris dans AGENTS (pin, fils, etc. ; les simples réponses/réactions à un déclencheur n’y passent pas) :
  1. *Permissions* : `verifyRequester` relit le message déclencheur sur Discord (auteur réel, déclencheur enregistré, < 15 min, pas déjà consommé). Les actions d’admin restent réservées au créateur (`CREATOR_ID`). `perms.js` calcule les permissions réelles. Limites dures : jamais viser le créateur, le propriétaire ou le bot ; jamais donner Administrator ; pas d’@everyone/@here ; pas de suppression du serveur ; pas de webhooks ; max 10 actions modificatrices ; purge ≤ 100. Un échec refuse tout le plan.
  2. *Plan* : `act.sh` n’exécute jamais d’action modificatrice. `createPlan` stocke un plan dans `data/pending_plans.json` et le poste avec les boutons `plan:confirm:<id>` / `plan:cancel:<id>`.
  3. *Confirmation* : seul le demandeur peut cliquer, une seule fois, avant expiration (10 min). Au Confirmer, tout est revérifié avec des données fraîches, puis les actions stockées sont exécutées, et le message du plan est mis à jour. Boutons uniquement. Journal dans `mod.log` ; le jeton n’est jamais journalisé.
- **DM** : `data/interactions.json` liste les utilisateurs qui ont déclenché le bot, lui ont écrit en DM, ou auxquels il a répondu. Un DM entrant est enregistré tout de suite comme cette première interaction, quel que soit l’utilisateur (plus de filtre « membre du serveur »). `send_dm`, `dm.sh` et `embed.sh --user-id` refusent toujours d’écrire en premier à quelqu’un qui ne l’a jamais contacté. Jamais de DM non sollicité.

## Roast du jour (salons AGENTS uniquement)

Demandé par le créateur, 2026-11-22. Voir aussi [docs/roast-du-jour.md](docs/roast-du-jour.md).

- `data/agents_contacts.json` liste les humains avec qui le bot a parlé **dans AGENTS**. Bots, créateur et le bot lui-même exclus.
- Une fois par jour (heure de Paris), à un horaire aléatoire entre 18 h et 22 h, le pont réveille la routine avec `trigger: "daily_roast"`, `message_id: null`, la cible et ses messages récents. Le post va dans le salon AGENTS où ils se sont parlé pour la dernière fois (repli : `FALLBACK_CHANNEL_ID`).
- `DAILY_ROAST=off` pour désactiver. Test manuel : `./scripts/roast_now.sh --dry-run [user_id]`.

## Pour les prochains agents de dev

- Toute nouvelle fonctionnalité qui parle à Discord doit passer par `scope.js` et, si elle crée, modifie ou supprime quoi que ce soit, par le workflow de plan dans `mod.js` (`prepare` → `createPlan` → bouton → `executePlan`). Jamais de chemin où la seule sortie du modèle déclenche un appel API modificateur.
- Ajouter un mapping de permission dans `prepare()` pour tout nouveau type d’action ; les types inconnus sont refusés.
- Après une modification : `node --check`, `npm test`, et en local un redémarrage `./scripts/stop.sh && ./scripts/start.sh` en vérifiant la ligne `ready` dans `bridge.log`.
- Ne jamais afficher ni écrire `DISCORD_BOT_TOKEN`, `ROUTINE_WEBHOOK_KEY`, `ACT_SHARED_SECRET`, ni aucune URL de webhook secrète.
