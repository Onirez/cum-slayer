# Vocal et présence

## Auto-vocal

Quand `AUTO_VOICE=on` (défaut), le pont surveille les salons vocaux et les scènes de tout le serveur autorisé (pas seulement AGENTS — exception du créateur). Le salon AFK est exclu.

- Il rejoint le salon qui contient le plus d’humains.
- `self_mute: false` (micro ouvert), `self_deaf: true` (casque coupé).
- Il part dès qu’il n’y a plus d’humain en vocal. Si la passerelle ignore le leave, un repli REST déconnecte le bot lui-même.
- Un debounce évite de sauter de salon en salon à chaque join/leave trop rapide.

L’implémentation utilise l’opcode gateway 4 (état vocal) plutôt qu’un flux audio `@discordjs/voice` : le bot est « présent », il n’envoie pas de son.

## Présence / statut

Les textes de statut vivent dans `data/statuses.json` (personnalité du bot, pas de données personnelles — ce fichier est versionné). Un statut est choisi de façon déterministe selon le jour et l’heure, fuseau **Europe/Paris** : « Joue à », « Écoute », « Regarde », etc.

On peut forcer un statut temporaire avec `data/status_override.json` (non versionné).
