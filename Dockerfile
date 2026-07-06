# syntax=docker/dockerfile:1
# projects-serve — ARM64 (Graviton) container image, Bun runtime.
# Amendment A1 pure-remote: the serve talks to cloud Postgres directly.

# ---- builder: install all deps + build the dist bundles ----
FROM --platform=linux/arm64 oven/bun:1.2-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---- runtime: production deps + built dist + migrations ----
FROM --platform=linux/arm64 oven/bun:1.2-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    HASNA_PROJECTS_STORAGE_MODE=cloud
WORKDIR /app

# Amazon RDS global CA bundle so TLS to the shared RDS validates (no
# SELF_SIGNED_CERT_IN_CHAIN). Node + pg trust it via NODE_EXTRA_CA_CERTS /
# PGSSLROOTCERT (the kit's fleet-standard TLS path).
RUN apk add --no-cache ca-certificates wget \
 && wget -qO /app/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem \
    PGSSLROOTCERT=/app/rds-global-bundle.pem

# Only production dependencies (pg, @hasna/contracts, etc. — the serve bundle
# externalizes these).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Built bundles + migration SQL (read at runtime by the migration ledger).
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/src/generated ./src/generated

# Bin wrappers so ECS task commands can invoke `projects-serve` / `projects`.
RUN printf '#!/bin/sh\nexec bun /app/dist/serve/index.js "$@"\n' > /usr/local/bin/projects-serve \
 && printf '#!/bin/sh\nexec bun /app/dist/cli/index.js "$@"\n'   > /usr/local/bin/projects \
 && printf '#!/bin/sh\nexec bun /app/dist/mcp/index.js "$@"\n'   > /usr/local/bin/projects-mcp \
 && chmod +x /usr/local/bin/projects-serve /usr/local/bin/projects /usr/local/bin/projects-mcp

EXPOSE 8080
# Default: run the HTTP API. The one-shot migration task overrides this with
# ["projects-serve", "migrate"].
CMD ["projects-serve"]
