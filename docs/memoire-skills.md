# Mémoire et skills

Deux magasins fichiers, dans `data/`, complémentent le payload envoyé à la routine. Ils ne sont pas versionnés (données personnelles). Le dépôt fournit des exemples vides.

## Mémoire utilisateurs

- Fichiers : `data/memory/<user_id>.json`.
- Champ principal : `memoryText` (budget 2000 caractères, append-only).
- Outil : `scripts/memory.sh get|list|append`.
- Dans `act.sh` : tableau `memory_append` : `{ subject, author, text }` (texte ≤ 400 caractères, fait durable uniquement).
- Un fait rapporté par un tiers est préfixé « `<@auteur> indique : …` ». On ne réécrit pas la mémoire, on l’enrichit.
- Rien de secret, pas de dump de vie privée, les identifiants Discord font foi (pas les surnoms).

La mémoire arrive déjà dans le payload (`memory.author`, `memory.mentioned`, et `memory.target` pour le roast). Inutile d’appeler `memory.sh get` sauf besoin exceptionnel.

## Skills

- Fichier : `data/skills.json` (`{ "skills": [ … ] }`).
- Une skill a un `trigger` (≤ 120 caractères, motifs ou IDs, jamais un simple nom affiché) et une `rule` (≤ 600 caractères).
- Outil : `scripts/skills.sh list|open|create`.
- Dans `act.sh` : `skill_create` : `{ author, trigger, rule }` quand quelqu’un demande un comportement durable.
- Les skills actives sont déjà dans le payload. Une skill dit *quand* la règle s’applique. Elle ne peut pas casser les garde-fous (règlement, secrets, plans).

Le fichier `data/skills.json` du dépôt est volontairement vide. Les skills créées en production restent sur le volume, pas dans git.

## Interactions

`data/interactions.json` n’est pas une mémoire de contenu : c’est la liste des utilisateurs avec qui le bot a déjà interagi, utilisée pour autoriser ou refuser un DM. Elle est alimentée automatiquement par le pont.
