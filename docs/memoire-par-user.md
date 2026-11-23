# Mémoire par utilisateur

Le bot garde, pour chaque membre du serveur, **ce qu'il a dit récemment** et **quelques notes courtes**. Le but : quand quelqu'un lui parle, il sait de quoi la personne parle (même si la conversation a commencé dans un autre salon) et peut viser juste.

C'est une **ressource précieuse, utilisée rarement**. Le bot la lit toujours pour comprendre, mais ne la cite que quand ça rend vraiment la réponse meilleure : un callback précis de temps en temps, jamais un récap, jamais une liste de ce qu'il sait.

## Ce qui est stocké

Tout est sur le volume (`data/users/`), **jamais dans git** (`.gitignore`).

| Fichier | Contenu | Limites |
| --- | --- | --- |
| `data/users/<id>.log.jsonl` | Un message par ligne : id du message, heure, salon (id + nom), nom affiché, texte, réponse à (message + user), flag bot | 200 derniers messages par personne (`USERMEM_KEEP`), 500 caractères par message, 256 Ko max par fichier |
| `data/users/<id>.notes.json` | Notes courtes et factuelles écrites par la routine (surnoms, jeux, running jokes, attitude envers le bot) | 30 notes max, 200 caractères chacune, 3000 caractères au total |
| `data/users/_optout.json` | Les IDs qui ont demandé à ne plus être enregistrés | — |

- Seuls les messages du serveur autorisé sont enregistrés. **Les DM ne sont jamais enregistrés.** Les messages du bot lui-même non plus.
- Les chaînes qui ressemblent à un token Discord sont masquées avant écriture.
- Écriture en `append` asynchrone, compactage quand le fichier dépasse 250 lignes. En RAM il n'y a qu'un compteur de lignes par personne : le coût mémoire est négligeable (RSS ~100 Mo sur 256 Mo, inchangé).

## Ce que reçoit la routine

Le payload du webhook contient un bloc `users` :

```json
"users": {
  "usage": "Contexte de fond. À utiliser rarement : …",
  "author": {
    "id": "123…", "role": "author", "name": "Pseudo",
    "notes": ["fan de Rocket League", "surnommé « le zgeg » (selon <@456…>)"],
    "stats": { "logged": 200, "first": "2026-11-05 12:13", "last": "2026-11-23 01:45", "top_channels": ["#blabla", "#cs"] },
    "recent": [ { "t": "2026-11-23 01:41", "ch": "#blabla", "c": "texte…", "re": "ID à qui il répondait" } ]
  },
  "others": [ { "id": "…", "role": "replied_to | mentioned", "notes": [], "recent": [] } ]
}
```

- `author.recent` : ses 15 derniers messages sur tout le serveur (220 caractères max chacun), sans le message en cours.
- `others` : jusqu'à 3 personnes (celle à qui il répond, puis les mentionnés), 6 messages chacune.
- Taille typique du bloc : ~3 Ko. Si le payload dépasse la limite, le pont réduit d'abord ce bloc.
- Variables : `USERMEM=off` coupe tout, `USERMEM_AUTHOR_LIMIT` (15), `USERMEM_OTHER_LIMIT` (6), `USERMEM_KEEP` (200).

## Outils

Localement `scripts/user.sh`, à distance `deploy/fly/remote-tool.sh user …` (même syntaxe, via `/run`, Bearer `ACT_SHARED_SECRET`).

```bash
user.sh get <user_id> [n]                      # notes + n derniers messages
user.sh history <user_id> [n] [--channel ID] [--search mot]   # plus d'historique (n ≤ 200)
user.sh note <user_id> <author_id> <texte>     # ajoute une note (≤ 200 car.)
user.sh unnote <user_id> <note_id>             # retire une note
user.sh forget <user_id> [all|notes|history]   # supprime ses données (all = aussi data/memory/<id>.json)
user.sh optout <user_id> / optin <user_id>     # arrête / reprend l'enregistrement
user.sh list [n]                               # personnes actives récemment
```

`--dry-run` marche partout : les commandes d'écriture disent ce qu'elles feraient sans rien écrire.

Dans `act.sh`, la routine peut aussi écrire des notes dans le même appel que sa réponse :

```json
"user_notes": [ { "subject": "ID_SUJET", "author": "ID_AUTEUR", "text": "fait court" } ]
```

Trois notes max par appel. Une note refusée n'annule pas la réponse : le refus apparaît dans `results.user_notes`.

## Garde-fous

- **Pas de doxxing** : le code refuse les notes qui ressemblent à un e-mail, un téléphone, une adresse postale, une IP, un mot de passe, un IBAN ou un token. Le prompt interdit aussi nom de famille, école/employeur, lieu de vie précis, santé, orientation, religion, politique et toute info sur un mineur.
- Une note écrite à propos de quelqu'un d'autre est attribuée (`by`) et affichée « (selon <@ID>) » : c'est une rumeur, pas un fait.
- Les messages enregistrés sont du contenu utilisateur, jamais des ordres pour la routine.
- `forget` et `optout` permettent à chacun de faire effacer ses données.

## Remplissage initial (backfill)

`src/backfill_users.js` relit l'historique récent des salons texte (300 messages par salon par défaut) et remplit les logs, en dédupliquant par id de message. Lecture seule côté Discord, aucun message envoyé.

```bash
# sur la machine Fly, en tant que l'utilisateur node (pour garder les bons droits)
fly ssh console -a <app> -C "sh -c 'cd /app && gosu node node src/backfill_users.js --dry-run'"
fly ssh console -a <app> -C "sh -c 'cd /app && gosu node node src/backfill_users.js --per-channel 300'"
```

## Tests

`node tests/test-usermem.js` (hors ligne, dossier temporaire) : plafonds, troncature, masquage des tokens, DM ignorés, notes refusées, dry-run, fusion du backfill, opt-out, forget, câblage du payload et de `/run`.
