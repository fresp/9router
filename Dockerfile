# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.23.4-alpine
ARG ALPINE_MIRROR=dl-cdn.alpinelinux.org
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG APP_VERSION=unknown
# npm bundled with the Node 22 image ships vulnerable transitive deps
# (brace-expansion, ip-address, pacote, picomatch, sigstore — 10 HIGH in the
# Trivy DB). The runtime still spawns npm (lazy runtime deps, updater), so it is
# upgraded to a pinned release instead of removed.
ARG NPM_VERSION=11.21.2

FROM ${NODE_IMAGE} AS base
ARG ALPINE_MIRROR
WORKDIR /app

# Use the official Alpine mirror by default. A repository variable/build arg can
# override it for environments that require a regional mirror.
RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

FROM base AS builder
ARG NPM_REGISTRY

RUN apk add --no-cache python3 make g++ linux-headers

# Install exactly what package-lock.json pins (versions + integrity hashes).
# `npm ci` fails when the lockfile is out of sync with package.json — refresh it
# with `npm install --package-lock-only --ignore-scripts` and commit the result.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci \
      --registry="${NPM_REGISTRY}" \
      --fetch-retries=5 \
      --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=300000

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# https://github.com/decolua/9router/issues/5245
# wreq-js and playwright-core are lazy runtime dependencies (loaded by
# lazyRuntime.js via createRequire). Next standalone tracing does not include
# them, so OpenCode Free fails with HTTP 502 ("resolve is undefined").
# Install them (with their native bindings/transitive deps) in an isolated dir
# so the runner stage can copy them into /app/node_modules. Versions come from
# the lockfile so this second install cannot drift from the audited set.
WORKDIR /opt/lazy-runtime
RUN --mount=type=cache,target=/root/.npm \
    npm init -y >/dev/null && \
    WREQ_JS_VERSION="$(node -p "require('/app/package-lock.json').packages['node_modules/wreq-js'].version")" && \
    PLAYWRIGHT_CORE_VERSION="$(node -p "require('/app/package-lock.json').packages['node_modules/playwright-core'].version")" && \
    npm install --no-save \
      --registry="${NPM_REGISTRY}" \
      --fetch-retries=5 \
      --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=300000 \
      "wreq-js@${WREQ_JS_VERSION}" "playwright-core@${PLAYWRIGHT_CORE_VERSION}"

FROM ${NODE_IMAGE} AS runner
ARG ALPINE_MIRROR
ARG APP_VERSION
ARG NPM_REGISTRY
ARG NPM_VERSION
WORKDIR /app

RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

LABEL org.opencontainers.image.title="9router" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id
# wreq-js + playwright-core (and deps) are lazy-loaded at runtime and omitted by
# tracing. See https://github.com/decolua/9router/issues/5245
COPY --from=builder /opt/lazy-runtime/node_modules/. ./node_modules/

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Avoid a full distribution upgrade in the runtime image. It makes builds less
# reproducible and is unrelated to installing the runtime entrypoint helper.
# zlib is upgraded explicitly (CVE-2026-4738, fixed in 1.4-r0).
RUN apk add --no-cache --upgrade su-exec ffmpeg zlib && \
  npm install -g --no-audit --no-fund --registry="${NPM_REGISTRY}" "npm@${NPM_VERSION}" && \
  npm cache clean --force && rm -rf /root/.npm && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
