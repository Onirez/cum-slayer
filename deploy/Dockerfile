# Image autonome du pont Discord (gateway). Contexte = racine du dépôt :
#   docker build -f deploy/Dockerfile -t cum-slayer .
# Ne pas mettre de secrets dans l'image : passer un env file au runtime.
#   docker run --env-file .env --restart unless-stopped -v cum-slayer-data:/app/data cum-slayer
FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY AGENTS.md ./
RUN chmod +x scripts/*.sh \
    && mkdir -p /app/data /app/data/memory /app/data/users \
    && chown -R node:node /app

USER node
ENV NODE_ENV=production
VOLUME ["/app/data"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/bridge.js"]
