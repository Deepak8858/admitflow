# syntax=docker/dockerfile:1.7
# Pin this argument to a reviewed Node 24 image digest in the release pipeline.
ARG NODE_IMAGE=node:24-bookworm-slim
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
ENV NEXT_PUBLIC_META_APP_ID=${NEXT_PUBLIC_META_APP_ID} \
    NEXT_PUBLIC_META_CONFIG_ID=${NEXT_PUBLIC_META_CONFIG_ID} \
    NEXT_PUBLIC_WORKOS_REDIRECT_URI=${NEXT_PUBLIC_WORKOS_REDIRECT_URI}
RUN test -n "$NEXT_PUBLIC_WORKOS_REDIRECT_URI" && npm run build && mkdir -p public

FROM base AS worker
ENV NODE_ENV=production ADMITFLOW_PROCESS_ROLE=worker
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=service-build --chown=node:node /app/dist ./dist
COPY --from=service-build --chown=node:node /app/drizzle ./drizzle
COPY --chown=node:node infra/entrypoint.mjs ./infra/entrypoint.mjs
USER node
ENTRYPOINT ["node", "infra/entrypoint.mjs"]
CMD ["node", "dist/worker.mjs"]

# Keep web as the default target; migrations reuse the worker image with a command override.
FROM base AS web
ENV NODE_ENV=production ADMITFLOW_PROCESS_ROLE=web HOSTNAME=0.0.0.0 PORT=3000
COPY --from=web-build --chown=node:node /app/.next/standalone ./
COPY --from=web-build --chown=node:node /app/.next/static ./.next/static
COPY --from=web-build --chown=node:node /app/public ./public
COPY --chown=node:node infra/entrypoint.mjs ./infra/entrypoint.mjs
USER node
EXPOSE 3000
ENTRYPOINT ["node", "infra/entrypoint.mjs"]
CMD ["node", "server.js"]
