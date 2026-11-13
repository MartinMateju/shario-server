# syntax=docker/dockerfile:1
# Build on the same Node major and libc used by the production runtime so Sharp
# and other native dependencies are installed for the target container platform.
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/install-voucher-fonts.mjs ./scripts/install-voucher-fonts.mjs
COPY assets/fonts/manrope/ ./assets/fonts/manrope/
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=4311
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/assets ./assets
COPY --chown=node:node scripts/container-healthcheck.mjs ./scripts/container-healthcheck.mjs
USER node
EXPOSE 4311
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "scripts/container-healthcheck.mjs"]
CMD ["node", "dist/server.js"]
