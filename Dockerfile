# cortex-gateway — production image
#
#   docker run -p 3213:3213 --env-file .env ghcr.io/wellknownmcp/cortex-gateway
#
# The gateway is configured entirely through env vars (see .env.example).
# The database is optional (audit persistence + gateway tickets + MCP adapter
# vault); without CORTEX_DATABASE_URL the gateway runs stateless.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runtime
# Ownership proof required by registry.modelcontextprotocol.io for OCI packages
LABEL io.modelcontextprotocol.server.name="io.github.wellknownmcp/cortex-gateway"
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3213 \
    HOSTNAME=0.0.0.0
RUN addgroup -S cortex && adduser -S cortex -G cortex
COPY --from=build --chown=cortex:cortex /app/.next/standalone ./
COPY --from=build --chown=cortex:cortex /app/.next/static ./.next/static
COPY --from=build --chown=cortex:cortex /app/prisma ./prisma
USER cortex
EXPOSE 3213
CMD ["node", "server.js"]
