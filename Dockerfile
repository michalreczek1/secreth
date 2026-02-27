FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY public ./public
COPY server ./server
COPY scripts ./scripts
COPY README.md ./

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
