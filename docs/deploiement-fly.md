# Déploiement sur Fly.io

Le pont doit tourner sur une machine allumée 24 h/24. En production il est sur **Fly.io**, région `cdg` (Paris), une seule machine `shared-cpu-1x` avec **256 Mo** de RAM, pour rester sous l’offre gratuite (environ 5 $ offerts par mois).

## Pourquoi ces réglages

- `fly deploy --ha=false` est obligatoire. Sans ce flag, Fly crée une deuxième machine et le budget dérape — et Discord n’accepte de toute façon qu’un seul gateway.
- `auto_stop_machines = "off"` et `min_machines_running = 1` : le bot ne doit jamais s’endormir.
- Volume `bridge_data` monté sur `/app/data` : mémoire, skills, plans, contacts.
- Après un deploy, le script détruit les apps `fly-builder-*` : leur volume de 50 Go ferait à lui seul dépasser le plafond.
- Un petit fichier swap de 128 Mo est créé sur le volume au démarrage, filet anti-OOM.

Vérifie quand même la page Billing de Fly à la fin du mois (la TVA peut faire légèrement dépasser le crédit).

## Prérequis

- Compte Fly (carte enregistrée).
- `flyctl` installé et `flyctl auth login`.
- Dans l’environnement de la machine qui déploie : `DISCORD_BOT_TOKEN`, `ROUTINE_WEBHOOK_URL`, `ROUTINE_WEBHOOK_KEY`.

## Commandes

Depuis la racine du dépôt, avec les secrets déjà exportés (jamais passés en argument, jamais journalisés) :

```bash
./deploy/fly/deploy-fly.sh --prepare   # crée l’app, le volume, importe les secrets (sans allumer le gateway)
./deploy/fly/deploy-fly.sh --deploy    # build + une seule machine (--ha=false)
./deploy/fly/deploy-fly.sh --seed      # optionnel : envoie data/ vers le volume
./deploy/fly/deploy-fly.sh --dry-run   # affiche la cible, ne change rien
```

Au premier `--prepare`, un `ACT_SHARED_SECRET` est généré dans `deploy/fly/.act_secret` (mode 600, **gitignoré**). Il faut le recopier dans l’environnement de la routine, pas dans git.

Santé :

```bash
fly logs -a cum-slayer-bridge
curl -sS https://cum-slayer-bridge.fly.dev/health
```

La réponse attendue ressemble à `{"ok":true,"ready":true}`.

## Après le déploiement

Pointe la routine vers le pont distant :

- `ACT_REMOTE_URL=https://cum-slayer-bridge.fly.dev`
- `ACT_SHARED_SECRET` identique au secret Fly

Les scripts `scripts/*.sh` proxifient alors automatiquement via `deploy/fly/remote-tool.sh`.

## Un seul pont à la fois

Avant d’allumer Fly, arrête tout pont local qui utiliserait le même jeton (`./scripts/stop.sh` sur cette machine). Sinon Discord bascule en boucle d’une session à l’autre.

## Docker sans Fly

```bash
docker build -f deploy/Dockerfile -t cum-slayer .
docker run --env-file .env --restart unless-stopped -v cum-slayer-data:/app/data cum-slayer
```

Ne jamais copier un `.env` dans l’image.
