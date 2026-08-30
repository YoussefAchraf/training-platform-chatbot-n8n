FROM node:26-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY index.js .
EXPOSE 9464
CMD sh -c 'if [ -f /vault/secrets/env ]; then set -a; . /vault/secrets/env; set +a; fi; exec node index.js'
