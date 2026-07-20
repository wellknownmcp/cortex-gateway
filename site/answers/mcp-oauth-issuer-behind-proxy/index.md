<!-- https://cortex-gateway.dev/answers/mcp-oauth-issuer-behind-proxy/ -->

# MCP OAuth behind a reverse proxy: the endless 401 loop

**TL;DR**

The user logs in, consents, comes back — and the very next call returns `401`, so the client logs in again. Forever. The cause is almost always that your server **computed a URL from the inbound request**. Behind a reverse proxy that request says `localhost:3000` over HTTP, while the client is talking to `https://mcp.example.com`. Every URL derived from it is wrong: the discovery challenge, the `resource` in your metadata, and — the one that causes the loop — the **expected token audience**. Pin the canonical URI in configuration. Never read it from a header.

## Two symptoms, one root cause

Deriving the origin from the request produces two different failures depending on where the wrong URL surfaces first.

| Symptom | Where the wrong URL appears |
| --- | --- |
| The connector does nothing at all, no login prompt | In the `WWW-Authenticate` challenge: the client fetches `http://localhost:3213/.well-known/…`, finds nothing, stops. (See [connector does nothing](/answers/mcp-connector-does-nothing/), cause 5.) |
| Login succeeds, then every call returns `401`, and the client re-authenticates in a loop | In the **audience check**: the client obtained a token for `https://mcp.example.com/mcp`, your server expects `http://localhost:3213/mcp`. The token is perfectly valid and perfectly rejected. |

The second is the more confusing of the two, because everything *works*: the flow completes, the token is signed, the user sees a consent screen. The failure is a string comparison nobody thought to log.

## Why frameworks get this wrong by default

Web frameworks build absolute URLs from the request they received: `new URL(req.url).origin`, `request.base_url`, `url_for(_external=True)`. On a laptop, that origin is the public origin, so everything works. In production the process sits behind nginx, a load balancer, or a platform router, and it receives `http://127.0.0.1:3000`. The framework is not wrong — it is answering the question it was asked. The question was wrong.

What makes this a security question and not merely a configuration one: the canonical resource URI is the value your server compares the token's `aud` claim against. It is an identifier, not a convenience.

## Do not reconstruct it from X-Forwarded-Host

The reflex is to read `X-Forwarded-Host` and `X-Forwarded-Proto` and rebuild the origin. Resist it. Those headers are set by whatever spoke to your process last. Unless every hop strips and re-sets them, an attacker who can reach your origin server directly controls the value — and therefore controls where discovery points and which audience you accept.

The public URL of your MCP endpoint is **a constant of the deployment**. It does not vary per request. It belongs in configuration:

```
CORTEX_CANONICAL_URI=https://mcp.example.com/mcp   # the resource identifier = expected audience
OAUTH_ISSUER=https://auth.example.com              # JWKS at /.well-known/jwks.json
```

Everything else derives from those two strings: the `resource_metadata` URL in the challenge, the `resource` field of the discovery document, and the audience the verifier enforces. One source of truth, no request involved.

## The audience check is the point, not an obstacle

It is tempting, once you understand the loop, to "fix" it by skipping the `aud` check. That trades a visible bug for an invisible vulnerability.

A token is not valid; it is valid *for a resource*. If your MCP server accepts any well-signed token from your authorization server, then a token your user granted to an unrelated application — an internal dashboard, a partner integration, a low-trust script — is silently honoured by your high-trust MCP endpoint. RFC 8707 resource indicators exist so the client can request a token scoped to exactly one resource, and the audience check is where that scoping becomes real. Bind it to the canonical URI and reject everything else.

## Three strings that must match exactly

OAuth compares these literally. A trailing slash breaks them. An `http` scheme breaks them. An internal hostname breaks them.

| String | Produced by | Consumed by |
| --- | --- | --- |
| Issuer | The `iss` claim in the token, and the authorization server's own metadata | Your verifier; the JWKS is fetched from it |
| Canonical resource URI | Your configuration | The `aud` check, the `resource` field of your metadata, and the challenge URL |
| Authorization server URL | The `authorization_servers` array you advertise | The client, to find the token endpoint |

If the authorization server also runs behind a proxy — and it usually does — it has the same disease: its `iss` claim and its own discovery document must carry the public URL, not the internal one.

## Verify it on the deployed URL

These checks cannot fail on localhost, which is exactly why they must run against production.

```
# 1. The metadata must describe the public resource
curl -s https://mcp.example.com/.well-known/oauth-protected-resource | jq .resource
# → "https://mcp.example.com/mcp"   (never localhost, never an internal host)

# 2. The challenge must point at the public metadata URL
curl -si -X POST https://mcp.example.com/mcp -d '{}' | grep -i www-authenticate

# 3. The token's audience must equal that same string, character for character
echo "$ACCESS_TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq '.aud, .iss'
```

Make check 1 a smoke test in your deployment pipeline. It is one HTTP call, it catches the whole family, and it is the difference between finding this in CI and finding it in a support thread.

## What Cortex Gateway does

[Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway) refuses to guess. The canonical URI is configuration (`CORTEX_CANONICAL_URI`), the expected audience defaults to it (overridable with `OAUTH_AUDIENCE` for the RFC 8707 audience-per-resource pattern), and the `WWW-Authenticate` challenge is built from it rather than from the inbound request. The issuer is required at boot — the process refuses to start without `OAUTH_ISSUER` — because a resource server that does not know its own authorization server has nothing useful to do.

The broader rule, worth carrying to any protocol: **a value used in a security comparison must never be derived from the message being checked.**

Full wiring, including scopes and revocation: [securing your MCP server with OAuth 2.1](/guides/secure-mcp-with-oauth/).

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### Why does my MCP client log in successfully and then get 401 again?

The token is valid but minted for a different resource than the one your server expects. Your server compares `aud` against its canonical resource URI; if that URI came from the inbound request behind a proxy, it says `localhost` while the token says `https://mcp.example.com/mcp`. Every call fails, the client re-authenticates, and the loop never ends.

### Why does my OAuth discovery document point at localhost?

Because the framework built the URL from the request it received, and behind a proxy that request carries the internal host and scheme. Configure the public canonical URI explicitly; never read it from the request.

### Should I trust X-Forwarded-Host to reconstruct the public origin?

No. Those headers are set by the previous hop and are spoofable unless every hop is trusted. The canonical URI does not vary per request — it is a constant of the deployment, so it belongs in configuration, not in a header.

### What is the audience of an MCP access token?

The canonical URI of the MCP resource, e.g. `https://mcp.example.com/mcp`. RFC 8707 lets the client request a token scoped to exactly that resource, and your server must reject any token whose `aud` does not match — otherwise a token granted to an unrelated application is accepted by your MCP endpoint.

### Can I just disable the audience check to stop the loop?

You can, and you will have replaced a visible bug with an invisible vulnerability. Any well-signed token from your authorization server — including one your user granted to a low-trust app — would then be honoured. Fix the URI instead; it is one environment variable.

### What must the OAuth issuer URL be behind a proxy?

The public HTTPS URL of the authorization server, identical to the `iss` claim in its tokens and to the `authorization_servers` entry you advertise. The three are compared literally: a trailing slash or an `http` scheme breaks validation, and a wrong issuer also means the JWKS cannot be fetched.

### How do I verify the canonical URI of a deployed server?

`curl -s https://mcp.example.com/.well-known/oauth-protected-resource | jq .resource`. It must return the public MCP endpoint. Then decode an access token and confirm `aud` is that same string, character for character.

### The challenge is right and the audience matches, but tools/list is empty. Same bug?

No — OAuth is working. That is a catalog or scope problem: see [why `tools/list` comes back empty](/answers/mcp-tools-list-empty/).
