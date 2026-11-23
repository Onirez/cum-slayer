#!/bin/sh
# Les volumes Fly sont souvent montés root:root. On active un petit swap
# sur le volume (filet anti-OOM en 256 Mo), on corrige les droits, puis
# on bascule sur l'utilisateur node. Aucun secret n'est journalisé.
set -eu
if [ "$(id -u)" -eq 0 ] && [ -d /app/data ]; then
  SWAP=/app/data/.swapfile
  if [ ! -f "$SWAP" ]; then
    if command -v fallocate >/dev/null 2>&1; then
      fallocate -l 128M "$SWAP" || dd if=/dev/zero of="$SWAP" bs=1M count=128
    else
      dd if=/dev/zero of="$SWAP" bs=1M count=128
    fi
  fi
  chmod 600 "$SWAP"
  mkswap "$SWAP" >/dev/null 2>&1 || true
  swapon "$SWAP" || true
  chown -R node:node /app/data || true
  chown root:root "$SWAP" || true
  chmod 600 "$SWAP" || true
fi
if [ "$(id -u)" -eq 0 ]; then
  exec gosu node "$@"
fi
exec "$@"
