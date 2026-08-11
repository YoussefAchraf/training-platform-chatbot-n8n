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
CMD sh -c 'if [ -f /vault/secrets/env ]; then . /vault/secrets/env; fi; exec node index.js'
