# Hosted demo deployment

Runbook for the public Cortex Gateway demo at `cortex-gateway.dev`. The DNS
topology mirrors the architecture — that is deliberate:

```
auth.cortex-gateway.dev   → cortex-demo-auth   (OAuth 2.1 issuer,   port 3220)
mcp.cortex-gateway.dev    → cortex-gateway     (MCP resource,       port 3213)
                            demo backend       (loopback only,      port 4820)
```

An MCP client pointed at `https://mcp.cortex-gateway.dev/mcp` discovers the issuer via
RFC 9728, self-registers (DCR), sends the visitor through magic-link login +
consent, and lands on a scope-filtered `tools/list`. The whole pitch,
experienced in ~30 seconds.

## 1. Prerequisites on the VM

- Node 22, PM2, nginx, certbot, PostgreSQL
- Two databases: `cortex_demo_auth` and `cortex_gateway` (the second is
  optional but recommended: audit + tickets)
- DNS A records for `auth.cortex-gateway.dev` and `mcp.cortex-gateway.dev` pointing at the VM

## 2. Auth server (port 3220)

```bash
cd cortex-gateway/demo/auth-server
npm install
bash scripts/generate-oauth-keys.sh >> .env
# complete .env: OAUTH_ISSUER=https://auth.cortex-gateway.dev,
#   OAUTH_MCP_AUDIENCE=https://mcp.cortex-gateway.dev/mcp, AUTH_DATABASE_URL,
#   RESEND_API_KEY (required for a public demo), INTROSPECT_CLIENT_SECRET
npx prisma db push
npm run build
pm2 start npm --name cortex-demo-auth -- start
```

## 3. Gateway (port 3213) + demo backend (port 4820)

```bash
cd cortex-gateway
npm install && npm run build
cat > .env <<EOF
CORTEX_CANONICAL_URI=https://mcp.cortex-gateway.dev/mcp
CORTEX_SERVER_NAME=cortex-gateway-demo
OAUTH_ISSUER=https://auth.cortex-gateway.dev
OAUTH_INTROSPECT_URL=https://auth.cortex-gateway.dev/oauth/introspect
OAUTH_INTROSPECT_CLIENT_ID=cortex-gateway
OAUTH_INTROSPECT_CLIENT_SECRET=<INTROSPECT_CLIENT_SECRET of the auth server>
CORTEX_BACKENDS=demo
CORTEX_BACKEND_DEMO_URL=http://127.0.0.1:4820
CORTEX_TECHNICAL_TOKEN=<openssl rand -base64 24>
CORTEX_ALLOWED_ORIGINS=https://claude.ai,*.anthropic.com
CORTEX_DATABASE_URL=postgresql://...cortex_gateway
CRON_SECRET=<openssl rand -base64 24>
EOF
pm2 start npm --name cortex-gateway-demo -- start
pm2 start examples/demo-backend/server.mjs --name cortex-demo-backend
pm2 save
```

(Or run the gateway from the Docker image:
`docker run -p 127.0.0.1:3213:3213 --env-file .env ghcr.io/wellknownmcp/cortex-gateway`.)

## 4. nginx

One server block per host; the important parts:

```nginx
server {
  server_name mcp.cortex-gateway.dev;
  location / {
    proxy_pass http://127.0.0.1:3213;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    # SSE (GET /mcp): disable buffering, long read timeout
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_http_version 1.1;
  }
}

server {
  server_name auth.cortex-gateway.dev;
  location / {
    proxy_pass http://127.0.0.1:3220;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

Then `certbot --nginx -d mcp.cortex-gateway.dev -d auth.cortex-gateway.dev`.

## 5. Smoke tests (must all pass)

```bash
# Discovery chain
curl -s https://mcp.cortex-gateway.dev/.well-known/oauth-protected-resource | jq .authorization_servers
curl -s https://auth.cortex-gateway.dev/.well-known/oauth-authorization-server | jq .authorization_endpoint
curl -s https://auth.cortex-gateway.dev/.well-known/jwks.json | jq '.keys[0].kid'

# 401 with correct WWW-Authenticate on the MCP endpoint
curl -si https://mcp.cortex-gateway.dev/mcp -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -i www-authenticate

# DCR
curl -s https://auth.cortex-gateway.dev/oauth/register -H 'Content-Type: application/json' \
  -d '{"client_name":"smoke","redirect_uris":["https://example.com/cb"]}' | jq .client_id

# The authorize redirect must point at auth.cortex-gateway.dev, NOT localhost
# (reverse-proxy issuer gotcha — this is the check that catches it)
curl -si "https://auth.cortex-gateway.dev/oauth/authorize?response_type=code&client_id=<id>&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&code_challenge=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&code_challenge_method=S256" | grep -i location
```

Then the real thing: add `https://mcp.cortex-gateway.dev/mcp` as a claude.ai Custom
Connector (or `npx @modelcontextprotocol/inspector`), complete the magic-link
+ consent flow, and verify `tools/list` returns the `demo_*` tools.

## 6. Registry listing

Once live, publish [registry/server.json](../registry/server.json) with the
`remotes` block enabled — checklist in [registry/README.md](../registry/README.md).

## Ops notes

- **Key rotation**: regenerate the keypair, restart auth — in-flight access
  tokens (≤15 min) fail verification and clients silently refresh. Acceptable
  for a demo.
- **Data hygiene**: magic links 15 min, sessions 7 d, codes 10 min, access
  15 min, refresh 30 d, grants 30 d. A weekly
  `DELETE FROM ... WHERE expires_at < now()` on the auth DB keeps it tidy.
- **Abuse**: DCR 5/h/IP, magic links 3/15min/email + 10/15min/IP, token 30/min,
  gateway 200 req/min per token. The demo tools are read-only and harmless.
