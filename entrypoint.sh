#!/bin/sh
set -e

if [ -f /vault/secrets/env ]; then
  set -a
  . /vault/secrets/env
  set +a
fi

echo "[entrypoint] Starting n8n..."
tini -- /docker-entrypoint.sh &
N8N_PID=$!

node /bootstrap.js || true

wait $N8N_PID
