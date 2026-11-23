# Fonctionnement du pont

Le pont est un processus Node qui ouvre une session **Discord Gateway** avec discord.js v14, et une petite API HTTP quand `ACT_HTTP=on`.

## Démarrage

- En local : `npm start` (processus seul) ou `./scripts/start.sh` (superviseur + watchdog + keeper).
- Sur Fly : le `Dockerfile` lance `node src/bridge.js` derrière `tini` et un entrypoint qui prépare le volume.

Les secrets viennent uniquement de l’environnement. Rien n’est lu depuis un fichier commité.

## Décision de déclenchement

Pour chaque message, `src/scope.js` `decideTrigger` produit l’un des identifiants suivants, ou rien :

| `trigger` | Quand |
| --- | --- |
| `mention` | Token `<@bot>` / `<@!bot>` (partout) ou mention dans AGENTS |
| `name` | Un des alias (`BOT_ALIASES`) dans AGENTS uniquement |
| `keyword` | Mot-clé `cum` / `cûm` dans AGENTS uniquement |
| `reply_to_bot` | Réponse à un message du bot (partout, exception du créateur) |
| `dm` | Message privé d’un membre du serveur autorisé |
| `daily_roast` | Tâche planifiée, pas un message (voir [roast-du-jour.md](roast-du-jour.md)) |

Les messages du bot lui-même ne déclenchent jamais.

## Commandes `/classement` et `/fiche`

- `/classement` `[periode]` `[salon]` : classement local des 10 membres les plus actifs, calculé sur les logs usermem (7 jours par défaut, 30 jours, ou tout). Sans IA, embed public, sans ping. Ignore les bots et les comptes opt-out. Délai 30 s par utilisateur.
- `/fiche membre:@user` : portrait rôti via la routine (`trigger: "slash_fiche"`). Le pont diffère l'interaction, envoie notes / stats / messages récents de la **cible**, et la routine répond avec `act.sh` + `interaction_id` (le jeton d'interaction reste sur le pont, il n'est jamais dans le payload). Si la cible a opté out ou n'a aucune donnée, réponse locale sans IA. Délai 60 s par utilisateur, plafond 20 fiches IA par heure.

Si le paragraphe `/restart` n'est pas juste au-dessus, voir plus bas.

## Commande `/restart`

Commande slash enregistrée sur le serveur (pas en global), visible par défaut seulement des administrateurs. Seul le créateur (`CREATOR_ID`) peut l’utiliser : le pont vérifie `interaction.user.id`, jamais un nom. Toute autre personne reçoit un refus éphémère. Le créateur reçoit « Redémarrage… » (éphémère), le client est détruit, le processus sort en code 1, et Fly relance la machine (`[[restart]] policy = "on-failure"`). Délai de 30 s entre deux redémarrages dans le même processus.
 Les autres bots suivent les mêmes règles, avec `BotLoopGuard` (5 réponses / 10 min / salon, reset si un humain écrit, 5 s entre deux messages du même bot).

## Payload envoyé à la routine

Le JSON contient notamment :

- `guild_id`, `channel_id`, `message_id`, `is_dm`, `in_agents`, `trigger`
- `author` (id, nom, `bot`)
- `content`, `recent` (jusqu’à 10 messages), `referenced` (`referenced.images` si le message cité contient une photo)
- `images` : jusqu’à 4 photos (`url`, `filename`, `content_type`, `width`, `height`, `size`) uniquement si le message mentionne le bot, l’appelle par un alias, répond à un de ses messages, ou est un DM. Jamais pour un autre bot ni un déclencheur ambiant. Fichiers > 10 Mo exclus. Un message peut n’être qu’une photo : il déclenche quand même s’il vise le bot.
- `mentions` (users, roles, channels)
- `guild` (salons, rôles, vocal, membre… ; `channels[].agents` pour le périmètre)
- `memory` (auteur, mentionnés)
- `users` : historique récent + notes de l'auteur et des personnes mentionnées / à qui il répond, marqué « contexte de fond, à utiliser rarement » ([détails](memoire-par-user.md))
- `skills` (trigger + règle des skills actives)

Aucun secret, aucun jeton, aucune URL de webhook n’y figure. Le pont tronque les textes trop longs pour rester sous une taille raisonnable.

## Outils que la routine peut appeler

| Script | Rôle |
| --- | --- |
| `scripts/act.sh` | Appel principal : répondre, réagir, écrire la mémoire, créer une skill, proposer un plan d’actions |
| `scripts/send.sh`, `reply.sh`, `dm.sh`, `embed.sh`, `react.sh` | Secours, un outil à la fois |
| `scripts/context.sh` | Relire un historique (rarement nécessaire : déjà dans le payload) |
| `scripts/img.sh` | Télécharger une photo du payload (`img.sh <url>`) depuis le CDN Discord vers `data/img-cache/`, affiche le chemin local (max 10 Mo, 15 s, hôtes `cdn.discordapp.com` / `media.discordapp.net` uniquement ; cache purgé après 24 h) |
| `scripts/memory.sh`, `skills.sh` | Lecture / écriture fichier |
| `scripts/user.sh` | Historique et notes par membre : `get`, `history`, `note`, `unnote`, `forget`, `optout` ([détails](memoire-par-user.md)) |
| `scripts/mod.sh` | Lectures serveur uniquement (`list_roles`, `member_info`, …) |
| `scripts/roast_now.sh` | Déclencher un roast à la main |

Quand la routine ne tourne pas sur la même machine que le pont, ces scripts détectent `ACT_REMOTE_URL` + `ACT_SHARED_SECRET` et proxifient vers `POST /act` ou `POST /run` (`deploy/fly/remote-tool.sh`).

## API HTTP du pont

Activée seulement si `ACT_HTTP` vaut `on` / `1` / `true`.

- `GET /health` — pas d’auth, utilisé par Fly. `{ ok, ready }`.
- `POST /act` — `Authorization: Bearer ${ACT_SHARED_SECRET}`, corps = JSON d’`act.sh`.
- `POST /run` — même auth, `{ tool, args?, stdin?, dry_run? }` pour les autres CLI. Liste blanche stricte d’outils, pas d’exécution de commandes libres.

Les comparaisons de jeton sont en temps constant. Les secrets ne sont jamais journalisés ni renvoyés dans la réponse.

## Garde à l’écriture

Même si la routine demande un `reply` ou un `react`, `act.js` refuse de poster hors AGENTS, hors déclencheur enregistré, hors fenêtre de 15 minutes, ou en DM envers quelqu’un qui n’a jamais interagi. Un `message_id` nul (post autonome, typiquement le roast) n’est accepté que dans ces mêmes conditions.
