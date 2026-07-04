# cortex-demo-auth

Demo **OAuth 2.1 authorization server** for the hosted Cortex Gateway demo —
the issuer behind `auth.<DOMAIN>`. Standalone Next.js app (not part of the
gateway build), following the validated authorization-server blueprint.

## What it implements

| Endpoint | Spec |
|---|---|
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `/.well-known/jwks.json` | JWKS (RS256 public key) |
| `POST /oauth/register` | RFC 7591 Dynamic Client Registration (open + rate-limited) |
| `GET /oauth/authorize` | OAuth 2.1 authorize, PKCE S256 mandatory |
| `GET /oauth/consent` + `POST /oauth/consent/submit` | Consent screen (30-day remembered grants) |
| `POST /oauth/token` | authorization_code + refresh_token (strict rotation, theft detection) |
| `POST /oauth/revoke` | RFC 7009 (client-authenticated, ownership-scoped) |
| `POST /oauth/introspect` | RFC 7662 (Basic-authenticated — the gateway's revocation check) |
| `/login` + magic-link API | Self-service signup (first sign-in creates the account) |

Token model: 15-min RS256 JWT access tokens (hybrid stateless + revocable —
SHA256 hash stored for early revocation), 30-day opaque refresh tokens with
strict rotation, 10-min single-use PKCE-bound codes. Tokens are never stored
in clear; IPs are truncated (/24) at write time.

Issued JWT claims match what cortex-gateway's resource verifier expects:
`sub`, `jti`, `scope`, `email`, `pool: "demo"`, `client_id`,
`aud = OAUTH_MCP_AUDIENCE`.

## Demo tiering

Every new account gets `mcp:demo:read` (see `User.scopes` default). Grant
`mcp:demo:write` to a user row to demonstrate scope-based tool visibility:
the gateway's `tools/list` changes accordingly — entitlements without
paywall logic.

## Deliberate demo deviations

- **DCR auto-approves** (production guidance: `pending` + admin approval).
  Acceptable here: tools are harmless and every token is user-consented.
- No admin dashboard, no audit table (stdout logs only).

## Run

```bash
cd demo/auth-server
npm install
bash scripts/generate-oauth-keys.sh >> .env   # then fill the rest of .env
npx prisma db push
npm run dev                                   # http://localhost:3220
```

Wire the gateway to it:

```bash
# gateway .env
OAUTH_ISSUER=https://auth.<DOMAIN>
CORTEX_CANONICAL_URI=https://mcp.<DOMAIN>/mcp
OAUTH_INTROSPECT_URL=https://auth.<DOMAIN>/oauth/introspect
OAUTH_INTROSPECT_CLIENT_ID=cortex-gateway
OAUTH_INTROSPECT_CLIENT_SECRET=<same as INTROSPECT_CLIENT_SECRET here>
```

Full topology and nginx/PM2 config: [docs/demo-deployment.md](../../docs/demo-deployment.md).
