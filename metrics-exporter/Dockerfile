FROM node:26-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY index.js .
EXPOSE 9464
CMD ["node", "index.js"]
