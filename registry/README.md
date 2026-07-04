# MCP registry listing

`server.json` is the manifest for registry.modelcontextprotocol.io —
**hybrid**: a `remotes` block (the hosted demo endpoint) plus an OCI
package (the GHCR image).

## Gotchas learned while publishing (2026-07)

- `description` is capped at **100 characters** (server-side check).
- OCI packages must **not** have `registryBaseUrl` — the canonical
  reference goes in `identifier` (`ghcr.io/owner/image:tag`).
- The registry proves image ownership by pulling the image and checking the
  OCI label — the Dockerfile must carry:
  `LABEL io.modelcontextprotocol.server.name="io.github.wellknownmcp/cortex-gateway"`
  and the image must be **public** on GHCR before publishing.
- `mcp-publisher validate` checks the schema only; `publish` runs deeper
  registry-side validation (the three rules above surface there).

## Publishing checklist

1. The schema evolves — validate against the live registry first:
   `mcp-publisher validate registry/server.json`
2. Tag a release so the Docker workflow publishes the image matching the
   `identifier` tag (workflow tags are `v*`-prefixed: `v0.1.0`). Make the
   GHCR package public (user profile → Packages → cortex-gateway → Package
   settings → Danger Zone).
3. `mcp-publisher login github` (interactive device flow — requires a TTY,
   run it yourself in a terminal) authenticated as **wellknownmcp** — the
   `io.github.wellknownmcp/*` namespace is verified against the GitHub account.
4. `mcp-publisher publish registry/server.json`
5. Verify: `curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=cortex-gateway"`
