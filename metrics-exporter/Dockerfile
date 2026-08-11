FROM node:26-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY index.js .
EXPOSE 9464
# Sources Vault Agent Injector's rendered secret file (if present) before
# starting - N8N_OWNER_PASSWORD arrives as a file at /vault/secrets/env in
# a Kubernetes deployment with Vault enabled, not as a process env var the
# way `docker compose`'s env_file delivers it. Falls through unchanged
# when that file doesn't exist (plain `docker compose up`, no Vault).
# `set -a` is required, not optional: plain `. file` only sets shell-local
# variables, not environment variables, so the exec'd child process never
# actually inherits them without it — confirmed the hard way on a live
# OKD cluster (this var was silently undefined in the child process the
# whole time without `set -a`).
CMD sh -c 'if [ -f /vault/secrets/env ]; then set -a; . /vault/secrets/env; set +a; fi; exec node index.js'
