# One container for the live demo: Express serves the API and the built React UI.
# FalkorDB is NOT in this image; point FALKORDB_* env vars at FalkorDB Cloud (or the compose service).

# Stage 1: build the UI. Only the static output (web/dist) is kept.
FROM node:24-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: the runtime image (server production deps only, no Vite/React toolchain).
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev
COPY package.json ./
COPY server/src server/src
COPY scripts scripts
COPY data/generate.js data/
# The generator is seeded and uses a fixed "now", so this graph is identical to the local one.
# It is what POST /api/admin/reseed (scripts/seed.js) loads into FalkorDB.
RUN node data/generate.js
COPY --from=web /app/web/dist web/dist
USER node
EXPOSE 8080
CMD ["node", "server/src/index.js"]
