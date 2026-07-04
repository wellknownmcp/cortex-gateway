# MCP registry listing

`server.json` is the draft manifest for registry.modelcontextprotocol.io.

Current state: **packages-only** (the GHCR Docker image). Once the hosted
demo is live, add the `remotes` block for a hybrid listing:

```jsonc
"remotes": [
  {
    "type": "streamable-http",
    "url": "https://mcp.<DOMAIN>/mcp"
  }
]
```

## Publishing checklist

1. The schema evolves — fetch the CURRENT version and validate before
   publishing (last known: 2025-12-11):
   `mcp-publisher validate registry/server.json`
2. Tag a release (`git tag v0.1.0 && git push --tags`) so the Docker workflow
   publishes `ghcr.io/wellknownmcp/cortex-gateway:0.1.0` matching `version`.
   Make the GHCR package public (GitHub → Packages → cortex-gateway →
   settings → visibility).
3. `mcp-publisher login github` (interactive device flow — requires a TTY,
   run it yourself in a terminal) authenticated as **wellknownmcp** — the
   `io.github.wellknownmcp/*` namespace is verified against the GitHub account.
4. `mcp-publisher publish registry/server.json`
5. Verify: `curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=cortex-gateway"`
