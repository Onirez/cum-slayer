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
| `BOT_LOOP_MAX` | `5` | Réponses consécutives à des bots, par salon |
| `BOT_LOOP_IDLE_MS` | `20000` | Remise à zéro après cette inactivité (20 s). Les messages de bots ignorés pendant la pause ne la prolongent pas. `BOT_LOOP_WINDOW_MS` est un alias conservé. |
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

## Mémoire par utilisateur

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `USERMEM` | `on` | `off` coupe l'enregistrement et le bloc `users` du payload |
| `USERMEM_KEEP` | `400` | Messages gardés par personne |
| `USERMEM_MAX_FILE_BYTES` | `393216` | Taille max d'un log par personne |
| `USERMEM_AUTHOR_LIMIT` | `15` | Messages de l'auteur injectés dans le payload |
| `USERMEM_OTHER_LIMIT` | `6` | Messages par personne mentionnée / citée |
| `USERMEM_DIR` | `data/users` | Dossier des logs et notes |
| `USERMEM_THROWBACK` | `on` | « Vieux message » occasionnel dans `users.author.throwback` |
| `USERMEM_THROWBACK_RATE` | `17` | Environ 1 déclenchement éligible sur N |
| `USERMEM_THROWBACK_COOLDOWN_MS` | `72000000` | Au plus une fois par personne toutes les 20 h |
| `USERMEM_THROWBACK_MIN_AGE_MS` | `259200000` | Message de plus de 3 jours |
