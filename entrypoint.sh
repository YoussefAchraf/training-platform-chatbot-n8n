#!/bin/sh
# Starts n8n normally, then runs bootstrap.js to bring it to a fully ready
# state (owner account, credentials, workflow imported + activated) with
# zero manual steps. The actual HTTP/session logic lives in bootstrap.js,
# written in Node rather than shell+wget because this image's wget is
# BusyBox's minimal build, which has no cookie-jar support at all (only
# GNU wget does) - found that the hard way, not guessed.
set -e

# Sources Vault Agent Injector's rendered secret file (if present) before
# starting - N8N_ENCRYPTION_KEY/N8N_OWNER_PASSWORD/AI_API_KEY/REDIS_PASSWORD
# arrive as a file at /vault/secrets/env in a Kubernetes deployment with
# Vault enabled, not as process env vars the way `docker compose`'s
# env_file delivers them. Falls through unchanged when that file doesn't
# exist (plain `docker compose up`, no Vault) — same fix already applied
# to metrics-exporter's Dockerfile (PR #7/#8).
# `set -a` is required, not optional: plain `. file` only sets shell-local
# variables, not environment variables, so tini/n8n (spawned right after,
# below) never actually inherits them without it — confirmed the hard way
# on a live OKD cluster (this var was silently undefined the whole time
# without `set -a`).
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
