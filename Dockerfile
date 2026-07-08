# syntax=docker/dockerfile:1
# projects-serve — ARM64 (Graviton) container image, Bun runtime.
# Amendment A1 pure-remote: the serve talks to cloud Postgres directly.

# ---- builder: install runtime deps + bundle the dist artifacts ----
FROM --platform=linux/arm64 oven/bun:1.2-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
# Production-only install: the sole devDependency that matters for a clean
# container build (@hasna/mcp-harness) is a `file:../open-mcp` link that does not
# exist in the build context, and typescript's `tsc` only emits .d.ts (dead weight
# in a runtime image). So we install runtime deps and bundle with bun's bundler
# directly instead of `bun run build`.
RUN bun install --frozen-lockfile --production
COPY . .
# Bundle exactly the JS artifacts the image runs (serve = ECS entrypoint) plus the
# `projects` CLI bin. The MCP bundle is intentionally skipped: it imports
# @hasna/mcp-harness (local file dep, absent here) and ECS never runs projects-mcp.
RUN bun build src/serve/index.ts --outdir dist/serve --target bun --external pg --external @hasna/contracts --external @hasna/contracts/auth --external @hasna/contracts/sdk \
 && bun build src/serve/app.ts   --outdir dist/serve --target bun --external pg --external @hasna/contracts --external @hasna/contracts/auth --external @hasna/contracts/sdk \
 && bun build src/cli/index.ts   --outdir dist/cli   --target bun --external pg --external @hasna/contracts --external @hasna/contracts/auth --external @hasna/contracts/schemas \
 && bun build src/sdk/index.ts   --outdir dist/sdk   --target bun \
 && bun build src/index.ts src/project-store.ts src/project-dashboard.ts --outdir dist --target bun --external pg --external @hasna/contracts --external @hasna/contracts/auth --external @hasna/contracts/schemas

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
# projects-mcp is not bundled into the server image (see builder note); its wrapper
# fails loudly rather than pointing at a missing file.
RUN printf '#!/bin/sh\nexec bun /app/dist/serve/index.js "$@"\n' > /usr/local/bin/projects-serve \
 && printf '#!/bin/sh\nexec bun /app/dist/cli/index.js "$@"\n'   > /usr/local/bin/projects \
 && printf '#!/bin/sh\necho "projects-mcp is not included in the server image" >&2; exit 1\n' > /usr/local/bin/projects-mcp \
 && chmod +x /usr/local/bin/projects-serve /usr/local/bin/projects /usr/local/bin/projects-mcp

EXPOSE 8080
# Default: run the HTTP API. The one-shot migration task overrides this with
# ["projects-serve", "migrate"].
CMD ["projects-serve"]
