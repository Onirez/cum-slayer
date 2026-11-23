# Configuration

Tous les réglages passent par l’environnement. `src/config.js` lit ces variables et fournit des valeurs d’exemple correspondant au serveur de production (Le Royaume). Copie `.env.example` vers `.env` (gitignoré) et remplis les secrets.

## Secrets (obligatoires en production)

| Variable | Rôle |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Jeton du bot Discord. Jamais journalisé. |
| `ROUTINE_WEBHOOK_URL` | URL du webhook qui réveille la routine IA. |
| `ROUTINE_WEBHOOK_KEY` | Jeton `Bearer` envoyé avec ce webhook. |
| `ACT_SHARED_SECRET` | Auth de `POST /act` et `POST /run` (Fly). |

Sans les deux variables de webhook, le pont se connecte quand même à Discord, journalise les déclencheurs, mais n’appelle pas la routine.

## Identité et périmètre

| Variable | Défaut d’exemple | Rôle |
| --- | --- | --- |
| `BOT_APP_ID` | id du bot cûm slayer | Identifiant applicatif Discord |
| `CREATOR_ID` | id d’Onirez | Seul utilisateur autorisé aux actions d’admin |
| `GUILD_ID` | Le Royaume | Serveur des outils de modération et du roast |
| `ALLOWED_GUILDS` | même id | Serveurs dont les messages (et DM de membres) sont acceptés |
| `AGENTS_CATEGORY_ID` | catégorie AGENTS | Périmètre libre |
| `FALLBACK_CHANNEL_ID` | salon agent-1 | Repli pour le roast du jour |
| `BOT_ALIASES` | `cûm slayer,cum slayer,slayer` | Surnoms, AGENTS uniquement |
| `ALLOW_DMS` | `1` | Accepter les DM des membres |
| `AUTO_VOICE` | `on` | Rejoindre le vocal le plus rempli |
| `DAILY_ROAST` | `on` | Activer le roast du jour |

## Limites

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `BOT_LOOP_MAX` | `5` | Réponses déclenchées par des bots, par salon |
| `BOT_LOOP_WINDOW_MS` | `600000` | Fenêtre de cette limite (10 min) |
| `BOT_AUTHOR_COOLDOWN_MS` | `5000` | Délai entre deux déclencheurs du même bot |
| `USER_COOLDOWN_MS` | `10000` | Délai par auteur (humain ou bot) |
| `GLOBAL_WINDOW_MS` / `GLOBAL_MAX` | 10 min / 20 | Quota global de déclencheurs |
| `WEBHOOK_TIMEOUT_MS` | `15000` | Timeout de l’appel à la routine |

## Pont distant et HTTP

| Variable | Rôle |
| --- | --- |
| `ACT_HTTP` | `on` pour écouter `/health`, `/act`, `/run` |
| `PORT` | Port HTTP (8080 sur Fly) |
| `ACT_REMOTE_URL` | Si la routine tourne ailleurs, URL du pont |
| `ACT_SHARED_SECRET` | Bearer pour `/act` et `/run` |
| `DATA_DIR` | Surcharge du répertoire d’état (défaut : `data/` à la racine) |

Les alias historiques `GROK_WEBHOOK_URL` / `GROK_WEBHOOK_KEY` sont encore lus en repli par `src/config.js` s’ils existent déjà dans un environnement, mais les nouveaux déploiements doivent utiliser `ROUTINE_*`.
