# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder
WORKDIR /app

RUN apk add --no-cache bash

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
COPY scripts/build-meta.sh ./scripts/build-meta.sh

RUN chmod +x ./scripts/build-meta.sh
RUN npm ci --workspace=@bridge/shared --workspace=@bridge/server
RUN npm run build -w @bridge/shared && npm run build -w @bridge/server
RUN npm prune --omit=dev --workspace=@bridge/shared --workspace=@bridge/server

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -S bridge && adduser -S bridge -G bridge

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/server/dist ./dist
COPY --from=builder /app/apps/server/migrations ./dist/apps/server/migrations

RUN mkdir -p /app/.bridge_uploads && chown -R bridge:bridge /app

USER bridge
EXPOSE 4000

CMD ["node", "dist/apps/server/src/index.js"]
