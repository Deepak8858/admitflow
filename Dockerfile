# syntax=docker/dockerfile:1.7
# The Debian image is build-only. Published stages use the patched shared-zlib runtime below.
ARG NODE_IMAGE=node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
ARG RUNTIME_IMAGE=cgr.dev/chainguard/wolfi-base@sha256:08df5982c3d27e70a4ce1607e3bb9af09d746f8722cf135a7694afef879fc5a2
FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS service-build
COPY . .
RUN node infra/build.mjs

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts && npm cache clean --force

FROM dependencies AS web-build
COPY . .
# Public configuration is inlined by Next. Never pass credentials as build arguments.
ARG NEXT_PUBLIC_META_APP_ID=""
ARG NEXT_PUBLIC_META_CONFIG_ID=""
ARG NEXT_PUBLIC_WORKOS_REDIRECT_URI
ARG PUBLIC_SEARCH_INDEXABLE=false
ENV NEXT_PUBLIC_META_APP_ID=${NEXT_PUBLIC_META_APP_ID} \
    NEXT_PUBLIC_META_CONFIG_ID=${NEXT_PUBLIC_META_CONFIG_ID} \
    NEXT_PUBLIC_WORKOS_REDIRECT_URI=${NEXT_PUBLIC_WORKOS_REDIRECT_URI} \
    PUBLIC_SEARCH_INDEXABLE=${PUBLIC_SEARCH_INDEXABLE}
RUN test -n "$NEXT_PUBLIC_WORKOS_REDIRECT_URI" && npm run build && mkdir -p public

FROM ${RUNTIME_IMAGE} AS runtime
# Wolfi Node links to this patched zlib, rather than Node's unpatched bundled copy.
# Keep APK metadata so image scanners can identify every installed system package.
RUN apk add --no-cache nodejs-24=24.21.0-r3 zlib=1.3.2.1_rc20260601-r0 \
    && addgroup -g 1000 node && adduser -D -u 1000 -G node node \
    && node -e "if (!process.config.variables.node_shared_zlib) process.exit(1)"
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM runtime AS worker
ENV NODE_ENV=production ADMITFLOW_PROCESS_ROLE=worker
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=service-build --chown=node:node /app/dist ./dist
COPY --from=service-build --chown=node:node /app/drizzle ./drizzle
COPY --chown=node:node infra/entrypoint.mjs ./infra/entrypoint.mjs
USER node
ENTRYPOINT ["node", "infra/entrypoint.mjs"]
CMD ["node", "dist/worker.mjs"]

# Keep web as the default target; migrations reuse the worker image with a command override.
FROM runtime AS web
ENV NODE_ENV=production ADMITFLOW_PROCESS_ROLE=web HOSTNAME=0.0.0.0 PORT=3000
COPY --from=web-build --chown=node:node /app/.next/standalone ./
COPY --from=web-build --chown=node:node /app/.next/static ./.next/static
COPY --from=web-build --chown=node:node /app/public ./public
COPY --chown=node:node infra/entrypoint.mjs ./infra/entrypoint.mjs
USER node
EXPOSE 3000
ENTRYPOINT ["node", "infra/entrypoint.mjs"]
CMD ["node", "server.js"]
