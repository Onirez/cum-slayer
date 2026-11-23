# Roast du jour

Une fois par jour, le bot envoie une pique à une personne avec qui il a déjà parlé dans un salon **AGENTS**. Demandé par le créateur le 22 novembre 2026.

## Qui peut être visé

- Humain, encore membre du serveur.
- Déjà en contact dans un salon AGENTS (`data/agents_contacts.json`).
- Ni le créateur, ni le bot, ni un autre bot.
- On évite de rerôtir la même personne pendant 5 jours ; s’il ne reste plus personne, on reprend le plus ancien.

Le salon de publication est celui où ils se sont parlé pour la dernière fois. S’il n’est plus dans AGENTS, repli sur `FALLBACK_CHANNEL_ID` (agent-1).

## Quand

- Fuseau **Europe/Paris**.
- Un horaire tiré au hasard **entre 18 h et 22 h** chaque jour.
- L’état (`data/daily_roast.json`) est réservé avant l’envoi : un redémarrage ne déclenche pas deux fois le même jour.
- Si le pont est éteint après 22 h, le jour est sauté.
- `DAILY_ROAST=off` désactive la fonction.

## Style attendu de la routine

Le pont réveille la routine avec `trigger: "daily_roast"`, `message_id: null`, `target`, `target_messages` et `memory.target`.

- Une seule attaque originale, bâtie sur **un** détail vrai (une phrase, une manie, une contradiction). Pas d’annonce du type « Roast du jour », pas de récapitulatif des messages.
- 2 à 5 phrases, un seul ping `<@target.id>`.
- Interdit : haine sur un trait protégé, vraies menaces, doxxing, quoi que ce soit impliquant des mineurs.
- Un seul `act.sh`, `message_id` null, pas d’`actions` (donc pas de plan), `react` null.

## Test manuel

```bash
./scripts/roast_now.sh --dry-run              # affiche le payload, n’envoie rien
./scripts/roast_now.sh --dry-run <user_id>    # force une cible
./scripts/roast_now.sh                        # envoie un vrai roast (hors planning)
```

Le test manuel n’avance pas la date du planning quotidien, mais inscrit la cible dans l’historique d’évitement.
