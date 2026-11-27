# Vocal et présence

## Auto-vocal

Quand `AUTO_VOICE=on` (défaut), le pont surveille les salons vocaux et les scènes de tout le serveur autorisé (pas seulement AGENTS — exception du créateur). Le salon AFK est exclu.

- Il rejoint le salon qui contient le plus d’humains.
- `self_mute: false` (micro ouvert), `self_deaf: true` (casque coupé).
- Il part dès qu’il n’y a plus d’humain en vocal. Si la passerelle ignore le leave, un repli REST déconnecte le bot lui-même.
- Un debounce évite de sauter de salon en salon à chaque join/leave trop rapide.

Quand quelqu’un (humain **ou bot**) arrive en vocal — première connexion, ou passage d’un salon vocal à un autre — le bot le salue à voix haute. S’il n’est pas déjà dans le salon d’arrivée, il le rejoint le temps du salut, puis l’auto-vocal peut le ramener vers le salon le plus rempli. Les phrases sont préécrites (français, style trash), le prénom est le nom d’affichage nettoyé pour la prononciation, et la voix vient d’un TTS neural gratuit sans clé (voix d’homme naturelle Microsoft Edge, `fr-FR-RemyMultilingualNeural`, pitch et débit par défaut ; repli sur Google Translate si Edge échoue). Pas d’appel au modèle. Cooldown d’environ 10 minutes par personne et par salon (changer de salon relance un salut ; une déco/reco dans le même salon, non). Si plusieurs personnes arrivent en même temps, les saluts sont mis en file, un par un. Quand le bot rejoint lui-même un salon, il ne salue pas ceux qui sont déjà là (courte période de grâce). Il ne se salue jamais lui-même.

Le flux audio passe par `@discordjs/voice` + ffmpeg + opusscript, déjà prévus. La connexion vocale a un délai d’abandon court ; si elle échoue, le bot reste simplement présent dans le salon (opcode 4) et le salut est sauté, sans faire planter le pont. `VOICE_GREET=off` désactive uniquement les saluts.

## Présence / statut

Les textes de statut vivent dans `data/statuses.json` (personnalité du bot, pas de données personnelles — ce fichier est versionné). Un statut est choisi de façon déterministe selon le jour et l’heure, fuseau **Europe/Paris** : « Joue à », « Écoute », « Regarde », etc.

On peut forcer un statut temporaire avec `data/status_override.json` (non versionné).
