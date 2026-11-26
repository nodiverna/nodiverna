# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
# pg_dump and pg_restore of PostgreSQL 17 (PGDG postgresql-client-17) for the
# backup before migrations and selfhost.mjs backup/restore. The major version
# must match the server (postgres:17-alpine in compose.yaml).
# The PGDG apt signing key ACCC4CF8.asc (PostgreSQL apt documentation,
# https://wiki.postgresql.org/wiki/Apt) is trusted only if its primary key has
# this full fingerprint, the same as the key in postgresql-common's
# pgdg/apt.postgresql.org.sh. apt gets a keyring with only this key. If PGDG
# changes the key, the build stops here: verify the new key, then update it.
RUN set -eu; \
    pgdg_fingerprint=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gpg gpg-agent; \
    GNUPGHOME="$(mktemp -d)"; export GNUPGHOME; \
    curl -fsSL -o "$GNUPGHOME/pgdg.asc" https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
    gpg --batch --quiet --import "$GNUPGHOME/pgdg.asc"; \
    gpg --batch --export "$pgdg_fingerprint" > "$GNUPGHOME/pgdg.gpg"; \
    primary="$(gpg --batch --show-keys --with-colons "$GNUPGHOME/pgdg.gpg" | awk -F: '$1 == "pub" { want = 1; next } $1 == "fpr" && want { print $10; want = 0 }' | tr -d ' ' | tr '[:lower:]' '[:upper:]')"; \
    if [ "$primary" != "$pgdg_fingerprint" ]; then echo "The PGDG apt key does not have the pinned fingerprint $pgdg_fingerprint (found: ${primary:-none})" >&2; exit 1; fi; \
    install -d -m 755 /etc/apt/keyrings; \
    install -m 644 "$GNUPGHOME/pgdg.gpg" /etc/apt/keyrings/pgdg.gpg; \
    gpgconf --kill all; \
    rm -rf "$GNUPGHOME"; \
    echo "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-17; \
    apt-get purge -y curl gpg gpg-agent; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS development
COPY --chown=node:node . .
RUN mkdir -p /data/objects /data/backups /app/.next && chown -R node:node /data /app
USER node
ENV HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
# Development TLS terminates at the Compose Caddy proxy; pnpm dev uses HTTPS
# for direct native development and is intentionally not used here.
CMD ["node", "node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "0.0.0.0", "--port", "3000"]

FROM dependencies AS build
COPY . .
RUN pnpm build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 \
    OBJECT_STORAGE_DRIVER=filesystem OBJECT_STORAGE_PATH=/data/objects BACKUP_DIRECTORY=/data/backups
# /data keeps the objects and the database backups; the database itself runs
# in its own PostgreSQL container (compose.yaml, service db).
RUN mkdir -p /data/objects /data/backups && chown -R node:node /data && chmod 700 /data/backups
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/runtime ./runtime
COPY --from=build --chown=node:node /app/scripts/selfhost.mjs ./scripts/selfhost.mjs
# The pinned publisher key for the release import of selfhost.mjs
# (runtime/release-import.mjs); the server has it in its bundle. The image
# holds no agent: an installation imports signed releases after the start.
COPY --from=build --chown=node:node /app/lib/release-publisher.json ./lib/
COPY --from=build --chown=node:node /app/drizzle ./drizzle
# The app version from the image workflow (scripts/app-release.mjs): X.Y.Z for a
# release, edge-<sha7> otherwise, dev for a local build. Only this stage has the
# ARG, so the build stage cache stays the same for each version.
ARG SERVERDESK_VERSION=dev
ENV SERVERDESK_VERSION=$SERVERDESK_VERSION
LABEL org.opencontainers.image.version=$SERVERDESK_VERSION
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health/ready',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--import", "./runtime/startup.mjs", "server.js"]
