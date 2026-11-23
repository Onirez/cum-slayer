# Build context = racine du dépôt (pas deploy/fly/).
# fly deploy --config deploy/fly/fly.toml --dockerfile deploy/fly/Dockerfile --ha=false
FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini gosu util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY fonts ./fonts
COPY AGENTS.md ./
COPY deploy/fly/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh /app/scripts/*.sh \
    && mkdir -p /app/data /app/data/memory /app/data/users

ENV NODE_ENV=production
ENV ACT_HTTP=on
ENV PORT=8080
ENV NODE_OPTIONS=--max-old-space-size=160
VOLUME ["/app/data"]
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["node", "src/bridge.js"]
