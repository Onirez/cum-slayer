# Vocal et présence

## Auto-vocal

Quand `AUTO_VOICE=on` (défaut), le pont surveille les salons vocaux et les scènes de tout le serveur autorisé (pas seulement AGENTS — exception du créateur). Le salon AFK est exclu.

- Il rejoint le salon qui contient le plus d’humains.
- `self_mute: false` (micro ouvert), `self_deaf: true` (casque coupé).
- Il part dès qu’il n’y a plus d’humain en vocal. Si la passerelle ignore le leave, un repli REST déconnecte le bot lui-même.
- Un debounce évite de sauter de salon en salon à chaque join/leave trop rapide.
- Si quelqu’un déplace le bot dans un salon vide alors que d’autres salons ont encore des humains, le bot ne quitte pas le vocal : il revient tout de suite (environ 1 s, `AUTO_VOICE_RETURN_MS`) dans le salon le plus rempli. Même chose s’il est expulsé du vocal. S’il n’y a plus aucun humain nulle part, il part comme avant.
- Après un salut, si la personne quitte le salon (ou change de salon), le bot revient tout de suite (~400 ms, `AUTO_VOICE_LEAVE_RETURN_MS`) dans le salon avec le plus d’humains, sans quitter le vocal. Même chose s’il se retrouve seul, ou dans un salon moins rempli que le plus occupé. Il ne bouge pas si son salon est déjà le plus rempli ou à égalité. Un salut encore en cours ou en file dans ce salon (ou un autre) a la priorité : le retour attend la fin de la file.

Quand quelqu’un (humain **ou bot**) arrive en vocal — première connexion, ou passage d’un salon vocal à un autre — le bot le salue à voix haute. S’il n’est pas déjà dans le salon d’arrivée, il le rejoint le temps du salut, puis l’auto-vocal peut le ramener vers le salon le plus rempli. Les phrases sont préécrites (français, style trash), le prénom est le nom d’affichage nettoyé pour la prononciation, et la voix vient d’un TTS neural gratuit sans clé (voix d’homme Microsoft Edge `fr-FR-HenriNeural` (monolingue français ; Remy multilingual basculait en anglais sur certains prénoms, et Edge refuse la balise SSML `<lang>`), pitch et débit par défaut, SSML `xml:lang="fr-FR"` ; repli sur Google Translate si Edge échoue). Au démarrage, et quand quelqu’un rejoint le serveur ou change de nom d’affichage, les 30 phrases sont pré-générées (Opus/OGG, volume `/app/data/tts-cache`) pour une lecture quasi instantanée, en priorité pour les gens déjà en vocal ou vus récemment. Pas d’appel au modèle. Le salut vise environ une seconde entre l’arrivée et le son (`VOICE_GREET_DELAY_MS`, 1000 ms par défaut) : le temps que le bot mette à rejoindre le salon compte dans ce délai, il ne s’ajoute pas après. Pas de cooldown par défaut : chaque arrivée ou changement de salon déclenche un salut (`VOICE_GREET_COOLDOWN_MS`, 0 par défaut). Si la même personne est déjà dans la file, le salut est simplement retargeté vers le nouveau salon. Si plusieurs personnes arrivent en même temps, les saluts sont mis en file, un par un (6 au plus). Quand le bot rejoint lui-même un salon, il ne salue pas ceux qui sont déjà là (courte période de grâce). Il ne se salue jamais lui-même.

Au démarrage, après un premier appel asynchrone à ffmpeg, le bot préchauffe aussi la pipeline `@discordjs/voice` / prism-media (`FFmpeg.getInfo` + un `createAudioResource` silencieux) : sinon le premier salut bloque la boucle d’événements plusieurs secondes sur un `spawnSync(ffmpeg -h)` et le health check échoue. Les clips Ogg des membres déjà en vocal sont aussi chargés en mémoire (64 fichiers / 1 Mio au plus, `TTS_MEM_CACHE_MAX` / `TTS_MEM_CACHE_BYTES`). Le flux audio passe par `@discordjs/voice` + ffmpeg + opusscript, déjà prévus. La connexion vocale a un délai d’abandon court ; si elle échoue, le bot reste simplement présent dans le salon (opcode 4) et le salut est sauté, sans faire planter le pont. `VOICE_GREET=off` désactive uniquement les saluts.

## Présence / statut

Les textes de statut vivent dans `data/statuses.json` (personnalité du bot, pas de données personnelles — ce fichier est versionné). Un statut est choisi de façon déterministe selon le jour et l’heure, fuseau **Europe/Paris** : « Joue à », « Écoute », « Regarde », etc.

On peut forcer un statut temporaire avec `data/status_override.json` (non versionné).
