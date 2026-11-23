# Règlement et sécurité

Le règlement a été publié dans le salon `📜┃règlement-agents` du serveur Le Royaume. Il est recopié dans [`AGENTS.md`](../AGENTS.md) et **appliqué par le code**, pas seulement par le modèle.

## Périmètre

- **Dans la catégorie AGENTS** : le bot peut parler et, via un plan confirmé, agir sans restriction de salon.
- **Hors AGENTS** : uniquement une `@` mention explicite, ou une réponse à l’un de ses messages (exception du créateur). Surnoms et mot-clé `cum`/`cûm` ignorés.
- **DM** : le bot répond à quiconque lui écrit en DM (cette prise de contact compte comme l’interaction initiale). Il refuse toujours d’ouvrir un DM vers quelqu’un qui ne l’a pas contacté en premier. Jamais de DM non sollicité.

## Plans Confirmer / Annuler

Toute action qui crée, modifie ou supprime quelque chose suit ce chemin, y compris dans AGENTS :

1. `verifyRequester` relit le message déclencheur sur Discord : auteur réel, déclencheur enregistré, moins de 15 minutes, pas déjà consommé, pas un bot ni un webhook.
2. `perms.js` calcule les permissions réelles du demandeur (propriétaire et Administrateur = tout ; rôles ; overwrites du salon ; les membres en timeout ne gardent que voir / lire l’historique). Les fils utilisent les overwrites du salon parent.
3. Les actions d’administration (kick, ban, timeout, rôles, salons, suppression de messages, etc.) sont **réservées au créateur** (`CREATOR_ID`) *et* exigent la permission Discord correspondante. `pin`, `unpin` et `create_thread` sont ouverts à tous, avec plan et permission. Les lectures (`list_*`, `member_info`, `audit_log`) s’exécutent tout de suite, sans plan.
4. Le plan est stocké dans `data/pending_plans.json` et posté dans le salon, avec la liste de chaque requête (méthode + route + cible lisible) et deux boutons. Il expire au bout de 10 minutes. Un message déclencheur ne sert qu’à un seul plan.
5. Seul le demandeur peut cliquer. Un autre membre reçoit un refus éphémère. Au Confirmer, tout est revérifié avec des données fraîches, puis exactement les actions stockées sont exécutées. Le message du plan est mis à jour et les boutons désactivés.

`act.sh` n’exécute jamais une action modificatrice lui-même.

## Limites dures (même pour le créateur)

- Ne jamais cibler le créateur, le propriétaire du serveur ou le bot (kick, ban, timeout, retrait de rôle, déconnexion vocale).
- Ne jamais accorder Administrator.
- Jamais d’`@everyone` / `@here` (les scripts neutralisent aussi ces mentions dans le texte).
- Pas de suppression du serveur, pas de touche aux webhooks ou intégrations.
- Maximum 10 actions modificatrices par plan, purge de messages ≤ 100.

## Anti-boucle et quotas

- Autres bots : 5 réponses consécutives à des bots par salon (mentions comprises), puis ignore silencieux (pas d’appel à la routine, pas de réaction) jusqu’à ce qu’un humain écrive dans le salon ou 20 secondes d’inactivité ; 5 s minimum entre deux déclencheurs du même bot. Les humains ne sont pas concernés.
- Tous auteurs : 10 s de cooldown par utilisateur, 20 déclencheurs globaux par 10 minutes (réglable, voir [configuration.md](configuration.md)).

## Secrets

Les secrets vivent uniquement dans l’environnement (ou les secrets Fly) :

- `DISCORD_BOT_TOKEN`
- `ROUTINE_WEBHOOK_URL` / `ROUTINE_WEBHOOK_KEY`
- `ACT_SHARED_SECRET`

Ils ne doivent jamais être journalisés, écrits dans `data/`, commités, ou renvoyés dans une réponse HTTP. Le pont journalise des noms de variables et des statuts, jamais des valeurs.
