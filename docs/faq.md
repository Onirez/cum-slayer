# FAQ et dépannage

## Le bot est « offline » sur Discord

1. Un seul processus gateway à la fois. Vérifie qu’un pont local n’est pas lancé en même temps que Fly : `./scripts/stop.sh` sur la machine locale, puis `fly status -a cum-slayer-bridge` et `fly logs -a cum-slayer-bridge`.
2. Santé HTTP : `curl -sS https://cum-slayer-bridge.fly.dev/health` doit renvoyer `ready: true`.
3. En local, `bridge.log` doit contenir une ligne `ready logged in as …`. Si le jeton manque, le processus refuse de démarrer (le message d’erreur nomme la variable, pas la valeur).

## Le bot est connecté mais ne répond pas

- Hors AGENTS, seuls une `@` mention explicite ou une réponse à un de ses messages le réveillent.
- Regarde `bridge.log` : `skip out-of-scope`, `skip bot-loop`, ou `skip webhook POST: ROUTINE_WEBHOOK_URL and/or ROUTINE_WEBHOOK_KEY missing`.
- Vérifie que les secrets de webhook sont bien dans les secrets Fly (`fly secrets list -a cum-slayer-bridge` affiche les **noms**, jamais les valeurs).

## `POST /act` renvoie 401

`ACT_SHARED_SECRET` de la routine doit être strictement identique à celui déposé sur Fly. Il se trouve en local dans `deploy/fly/.act_secret` s’il a été généré par le script de deploy (fichier gitignoré, ne jamais le commiter).

## Un plan est refusé

La sortie de `act.sh` contient `plan REFUSED: …`. Causes fréquentes : le demandeur n’est pas le créateur pour une action d’admin, il n’a pas la permission Discord, la cible est protégée (créateur / propriétaire / bot), le déclencheur a plus de 15 minutes, ou c’est un bot qui demande l’action.

## Le roast n’est pas sorti ce soir

- `DAILY_ROAST` est peut-être `off`.
- Le pont était à l’arrêt après 22 h (heure de Paris) : le jour est sauté.
- Aucun contact éligible dans `data/agents_contacts.json`.
- Pour tester : `./scripts/roast_now.sh --dry-run`.

## OOM / machine Fly qui redémarre

La machine a 256 Mo plus 128 Mo de swap sur le volume. Évite d’ajouter des dépendances lourdes. Ne passe pas à une taille supérieure sans regarder le plafond des 5 $.

## Relancer proprement en local

```bash
./scripts/stop.sh && ./scripts/start.sh
# puis
tail -f bridge.log
```

Les motifs du watchdog et du keeper incluent le chemin du dépôt : ils ne touchent pas un autre checkout qui tournerait sur la même machine.
