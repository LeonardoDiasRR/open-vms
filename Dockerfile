# estagio 1: constroi o cliente
FROM node:22-alpine AS cliente
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
ARG VITE_ARCHIVE_ADAPTIVE_PREVIEW=0
ENV VITE_ARCHIVE_ADAPTIVE_PREVIEW=$VITE_ARCHIVE_ADAPTIVE_PREVIEW
RUN npm run build

# Instala a dependencia do gravador antes de copiar o codigo da API.
FROM node:22-alpine AS ffmpeg
COPY scripts/install-ffmpeg.sh /usr/local/bin/install-ffmpeg.sh
RUN sh /usr/local/bin/install-ffmpeg.sh

# estagio 2: o servidor
FROM ffmpeg AS api
WORKDIR /app
ENV NODE_ENV=production
# ponytail: pg e a unica dep de runtime do servidor (server/package.json); sem ela o modo
# postgres do compose (OPENVMS_PG_URL) quebra no boot — `node_modules` esta no .dockerignore
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/ ./server/
# ponytail: o dist fica na imagem para o servico one-shot `dist` do compose copiar para o nginx
COPY --from=cliente /app/client/dist ./client/dist
EXPOSE 7101
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:7101/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/main.js"]

