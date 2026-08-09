#!/bin/sh
# Starts n8n normally, then runs bootstrap.js to bring it to a fully ready
# state (owner account, credentials, workflow imported + activated) with
# zero manual steps. The actual HTTP/session logic lives in bootstrap.js,
# written in Node rather than shell+wget because this image's wget is
# BusyBox's minimal build, which has no cookie-jar support at all (only
# GNU wget does) - found that the hard way, not guessed.
set -e

echo "[entrypoint] Starting n8n..."
tini -- /docker-entrypoint.sh &
N8N_PID=$!

node /bootstrap.js || true

wait $N8N_PID
