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
| `dm` | Message privé de quiconque écrit au bot |
| `daily_roast` | Tâche planifiée, pas un message (voir [roast-du-jour.md](roast-du-jour.md)) |
| `follow` | Message humain, sans mention / alias / réponse, dans un salon où le bot vient de parler (fenêtre de 2 min). Jamais en DM, jamais pour un bot, jamais si l’auteur a opté out. |

Les messages du bot lui-même ne déclenchent jamais.

### Suivi de conversation (`follow`)

Après chaque réponse de cûm slayer dans un salon (hors réponses aux commandes slash `/stats`, `/fiche`, `/restart`), le pont ouvre une fenêtre de 2 minutes (`FOLLOW_WINDOW_MS`, défaut 120000). Pendant cette fenêtre, un message d’humain sans mention, alias ni réponse au bot est quand même envoyé à la routine avec `trigger: "follow"`, et le contexte `recent` habituel. Les messages d’autres bots ne déclenchent jamais le suivi ; `BotLoopGuard` reste inchangé.

Garde-fous : au plus 3 suivis par fenêtre et par salon (`FOLLOW_MAX_PER_WINDOW`) ; debounce de 4,5 s (`FOLLOW_DEBOUNCE_MS`) pour regrouper les messages rapides d’une même personne en un seul réveil (le plus récent sert de cible) ; plafond global de 30 suivis par heure (`FOLLOW_HOURLY_MAX`). Une réponse du bot à un follow relance la fenêtre, mais le compteur de 3 ne se remet à zéro que sur une vraie interpellation humaine (mention, alias, mot-clé, ou réponse au bot). Le suivi n’utilise pas le délai de 10 s par auteur ni le quota global 20/10 min. Pas d’indicateur « en train d’écrire », pas de throwback. Les photos du message humain sont jointes si présentes (jamais celles d’un bot). État en mémoire : un redémarrage ou un déploiement efface les fenêtres. `FOLLOW=off` coupe le suivi.

## Commandes `/stats` et `/fiche`

- `/stats` : infographie PNG calculée **en direct** à chaque appel à partir des logs usermem (totaux = stock plafonné à 400 messages/membre). Sans IA, réponse publique (le pont diffère puis joint l’image). Cooldown 30 s par utilisateur ; un seul rendu à la fois (machine 256 Mo). Compteurs all-time dans `data/lifetime.json` : déclencheurs par type, images vs vidéos, usages de `/stats`, et un compteur monotone **messages lus depuis toujours** (indépendant du plafond 400, amorcé sur le stock au premier déploiement, un id de message ne compte qu’une fois). Si un scan `data/full_count.json` est présent, un bandeau **Total du serveur (historique complet)** affiche le vrai total du serveur (tous salons et fils accessibles, y compris archives) avec la date du scan, sans remplacer le compteur « lus depuis toujours ». Relancer le scan : `npm run count:full` (ou `scripts/full_count.sh`, éventuellement `--fresh`). Lecture seule, aucun contenu de message n’est conservé ; les salons déjà supprimés sont irrécupérables. L’ancienne commande `/classement` a été retirée (les données usermem restent).
- `/fiche membre:@user` : portrait rôti via la routine (`trigger: "slash_fiche"`). Le pont diffère l'interaction, envoie notes / stats / messages récents de la **cible**, et la routine répond avec `act.sh` + `interaction_id` (le jeton d'interaction reste sur le pont, il n'est jamais dans le payload). Si la cible a opté out ou n'a aucune donnée, réponse locale sans IA. Délai 60 s par utilisateur, plafond 20 fiches IA par heure.

Si le paragraphe `/restart` n'est pas juste au-dessus, voir plus bas.

## Commande `/restart`

Commande slash enregistrée sur le serveur (pas en global), visible par défaut seulement des administrateurs. Seul le créateur (`CREATOR_ID`) peut l’utiliser : le pont vérifie `interaction.user.id`, jamais un nom. Toute autre personne reçoit un refus éphémère. Le créateur reçoit « Redémarrage… » (éphémère), le client est détruit, le processus sort en code 1, et Fly relance la machine (`[[restart]] policy = "on-failure"`). Délai de 30 s entre deux redémarrages dans le même processus.
 Les autres bots suivent les mêmes règles, avec `BotLoopGuard` (5 réponses consécutives à des bots par salon, y compris les mentions ; ensuite silence, sans webhook ni réaction, jusqu’à un message humain ou 20 s d’inactivité ; 5 s entre deux messages du même bot). Les humains ne sont pas concernés. `BOT_LOOP_MAX` et `BOT_LOOP_IDLE_MS` sont configurables.

## Payload envoyé à la routine

Le JSON contient notamment :

- `guild_id`, `channel_id`, `message_id`, `is_dm`, `in_agents`, `trigger`
- `author` (id, nom, `bot`)
- `content`, `recent` (jusqu’à 10 messages, chacun avec `message_id` et, s’il y a des pièces jointes, `images` / `videos` avec leurs `url`), `referenced` (`referenced.images` / `referenced.videos` si le message cité contient une photo ou une vidéo, même si le message actuel n’en a pas). Un message sans texte mais avec une pièce jointe n’est plus envoyé vide : `content` porte une annotation du type `[vidéo: clip.mov]`, et `attachments_summary` liste les fichiers (nom, type, taille), sans URL.
- `images` : jusqu’à 4 photos (`url`, `filename`, `content_type`, `width`, `height`, `size`) uniquement si le message mentionne le bot, l’appelle par un alias, répond à un de ses messages, est un DM, ou est un suivi de conversation humain (`trigger: "follow"`). Jamais pour un autre bot ni un déclencheur ambiant (mot-clé seul). Fichiers > 10 Mo exclus. Un message peut n’être qu’une photo : il déclenche quand même s’il vise le bot.
- `videos` : jusqu’à 2 vidéos (`url`, `filename`, `content_type` mp4 / quicktime / webm, `width`, `height`, `size`, `duration` si dispo, `proxy_url`, `thumbnail` si fourni), mêmes conditions que `images`. Pièces jointes vidéo et embeds vidéo / gifv (Tenor, Giphy, Discord). Un gif classique (`image/gif`) reste dans `images`. Fichiers > 25 Mo exclus de `videos` mais décrits dans `attachments_summary`. Un message peut n’être qu’une vidéo.

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
| `scripts/context.sh` | Relire un historique autour d’un `message_id` (`context.sh <channel_id> <message_id>`). Chaque message du JSON inclut maintenant `images` / `videos` (urls) s’il y a des pièces jointes — pour analyser une vidéo plus ancienne que la fenêtre `recent`. |
| `scripts/img.sh` | Télécharger une photo du payload (`img.sh <url>`) depuis le CDN Discord vers `data/img-cache/`, affiche le chemin local (max 10 Mo, 15 s, hôtes `cdn.discordapp.com` / `media.discordapp.net` uniquement ; cache purgé après 24 h) |
| `scripts/vid.sh` | Télécharger une vidéo du payload (`vid.sh <url>`) depuis le CDN Discord, Tenor ou Giphy vers `data/vid-cache/`, extraire 3–4 images JPEG, transcrire les ~60 premières secondes de parole en local (faster-whisper, modèle `base`, fr/en, langue auto), afficher les chemins, `duration_s`, `language` et `transcript` (max 25 Mo, plafond total ~28 s ; cache purgé après 24 h). Affiche `pas de piste audio` / `aucune parole détectée` si besoin. S’exécute sur la machine de la routine, pas sur Fly (ffmpeg + modèle Whisper restent sur la box). |
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

Même si la routine demande un `reply` ou un `react`, `act.js` refuse de poster hors AGENTS, hors déclencheur enregistré, hors fenêtre de 15 minutes, ou en DM envers quelqu’un qui n’a jamais écrit au bot. Un DM entrant est enregistré tout de suite comme cette interaction, donc la réponse dans le même salon DM passe. Un `message_id` nul (post autonome, typiquement le roast) n’est accepté que dans ces mêmes conditions.
