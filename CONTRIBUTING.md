# Contribuer

Merci de l’intérêt. Ce dépôt est le pont Discord de **cûm slayer**, pas la routine IA elle-même.

## Avant de proposer un changement

1. Lis [`AGENTS.md`](AGENTS.md) : le règlement du serveur et les garde-fous y sont détaillés.
2. Garde le changement petit et ciblé. Pas de refactor « en passant ».
3. Les identifiants de serveur se configurent via l’environnement (`src/config.js`). N’en ajoute pas de nouveaux en dur.
4. Toute action Discord qui crée, modifie ou supprime quelque chose doit passer par le workflow de plan (boutons Confirmer / Annuler).

## Commandes

```bash
npm install
npm run check
npm test
```

Les tests live (`npm run test:live`) parlent au serveur Discord de production et exigent `DISCORD_BOT_TOKEN`. Ne les lance que si tu sais ce que tu fais.

## Secrets

Jamais dans un commit, un journal, une issue ou une capture d’écran :

- `DISCORD_BOT_TOKEN`
- `ROUTINE_WEBHOOK_URL` / `ROUTINE_WEBHOOK_KEY`
- `ACT_SHARED_SECRET`
- fichiers `.env`, `deploy/fly/.act_secret`, `data/` runtime (mémoire, interactions, plans)

`.env.example` et les fichiers `data/*.example.json` sont les seuls modèles à commiter.

## Style

- JavaScript CommonJS, Node 24, `discord.js` v14.
- Commentaires en anglais dans le code, documentation utilisateur en français.
- Pas de dépendance nouvelle sans en discuter d’abord.
