# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder
WORKDIR /app

RUN apk add --no-cache bash

ARG VITE_API_URL=http://localhost:4000
ARG VITE_WS_URL=ws://localhost:4000
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_WS_URL=${VITE_WS_URL}

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
COPY scripts/build-meta.sh ./scripts/build-meta.sh

RUN chmod +x ./scripts/build-meta.sh
RUN npm ci --workspace=@bridge/shared --workspace=@bridge/web
RUN npm run build -w @bridge/shared && npm run build -w @bridge/web

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
