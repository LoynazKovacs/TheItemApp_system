# syntax=docker/dockerfile:1
#
# System API backend: Fastify app-container that samples the Docker socket +
# nvidia-smi and publishes system_* resource rows to core.
#

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm install
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npx tsc -p tsconfig.json

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY dbseed ./dbseed

EXPOSE 3009

HEALTHCHECK --interval=10s --timeout=5s --retries=10 --start-period=30s \
  CMD node -e "require('http').get('http://127.0.0.1:3009/api/health', (r) => { r.resume(); process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "dist/index.js"]
