# syntax=docker/dockerfile:1
# The mcp-feedback ingest hub: collects feedback from installed copies of your MCP servers and
# serves the reader tools for all of them. Configuration is environment variables; see hub/README.md.
#
#   docker build -f hub/Dockerfile -t mcp-feedback-hub .     (from the repository root)

# Build the package from this repository and pack it exactly as npm would publish it.
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/typescript/package.json packages/typescript/
# The lockfile covers every workspace package, so their manifests come along; only the package is installed.
COPY examples/express-server/package.json examples/express-server/
COPY examples/stdio-server/package.json examples/stdio-server/
RUN pnpm install --frozen-lockfile --filter mcp-feedback
COPY packages/typescript packages/typescript
COPY skills skills
RUN pnpm --filter mcp-feedback build \
 && cd packages/typescript \
 && npm pack --pack-destination /dist \
 && mv /dist/mcp-feedback-*.tgz /dist/mcp-feedback.tgz

# Install the packed package, with its runtime dependencies only, as a published install would.
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    MCP_FEEDBACK_INGEST_HOST=0.0.0.0 \
    PORT=8787
COPY --from=build /dist/mcp-feedback.tgz /tmp/
RUN npm install --global --omit=dev /tmp/mcp-feedback.tgz \
 && npm cache clean --force \
 && rm /tmp/mcp-feedback.tgz \
 && mkdir -p /data && chown node:node /data
USER node
WORKDIR /data
# For a SQLite store (MCP_FEEDBACK_DB=/data/feedback.db). Not needed with Postgres.
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["mcp-feedback", "ingest"]
CMD ["serve"]
