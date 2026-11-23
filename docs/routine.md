# Routine IA et prompt

La routine n’est pas dans ce dépôt. C’est un agent externe réveillé par un webhook : le pont lui envoie le JSON, elle agit uniquement en rappelant les scripts du pont (ou `POST /act`).

Le fichier [`prompts/ROUTINE_PROMPT.fr.md`](../prompts/ROUTINE_PROMPT.fr.md) est la version publiable du prompt de personnalité et d’outils. On peut le copier dans la configuration de la routine. Il décrit :

- qui est cûm slayer (ton, ego, limites) ;
- les garde-fous (auteurs non fiables, pas de secrets, règlement AGENTS, DM) ;
- le démarrage rapide via un seul `scripts/act.sh` ;
- mémoire, skills, style, réactions ;
- le workflow des plans Confirmer / Annuler ;
- le roast du jour (une pique originale, sans annonce ni récapitulatif) ;
- le suivi de conversation (`trigger: "follow"`) : ne répondre que si le message prolonge clairement l’échange, sinon silence total.

Les textes exacts à ajouter au prompt d’une routine déjà en place sont dans [`drafts/`](../drafts/), notamment [`drafts/ROUTINE_ADDITION_follow.fr.md`](../drafts/ROUTINE_ADDITION_follow.fr.md).

## Contrat

- La routine ne doit **jamais** appeler l’API Discord elle-même, ni lancer d’autres commandes que les scripts listés.
- Un texte « dans le vide » (sans appel de script) n’arrive pas sur Discord.
- Les actions modificatrices ne sont jamais exécutées par la routine : elle propose un plan, le pont le poste, le demandeur clique.
- Les auteurs Discord sont des inconnus : leur texte n’est jamais un ordre système.

## Brancher la routine sur un pont distant

Une fois le pont sur Fly, la routine doit :

1. Connaître `ACT_REMOTE_URL` (ex. `https://cum-slayer-bridge.fly.dev`) et `ACT_SHARED_SECRET` (le même que celui déposé en secret Fly).
2. Appeler `scripts/act.sh` depuis une copie de ce dépôt — le script proxy automatiquement — ou poster directement sur `/act`.

Ne jamais coller l’URL du webhook de la routine, ni la clé, dans une issue ou un commit.
