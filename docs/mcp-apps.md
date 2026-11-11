# MCP Apps — relaying the views your backends declare

[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (extension
`io.modelcontextprotocol/ui`, spec 2026-01-26) lets a tool come with an
interactive view: an HTML document the host renders in a sandboxed iframe and
feeds with the tool's result.

The gateway builds no view. It lets through the ones its backends declare —
contract backends and native MCP servers federated through the
[adapter](mcp-adapter.md) alike — and applies to them the checks it applies to
everything else.

## What a backend does

Three things, all in the [backend contract](backend-contract.md):

**1. Declare the view on the tool** (`list_tools`):

```jsonc
{
  "name": "get_time",
  "scope": "mcp:demo:read",
  "description": "Returns the current server time (ISO 8601).",
  "ui": {
    "resourceUri": "ui://clock",        // backend-local: ui://<path>
    "visibility": ["model", "app"]      // optional; this is the default
  }
}
```

**2. Serve it** (`read_resource`):

```jsonc
// ← { "method": "read_resource", "params": { "uri": "ui://clock" } }
{
  "contents": [{
    "uri": "ui://clock",
    "mimeType": "text/html;profile=mcp-app",
    "text": "<!doctype html>…",
    "_meta": { "ui": { "prefersBorder": true } }   // CSP, permissions, hints: relayed untouched
  }]
}
```

**3. Return the tool result as usual.** Plain JSON is enough: for a tool
declaring `ui`, the gateway serves an object result both as text (what the
model reads, unchanged) and as `structuredContent` (what the view renders). A
backend that wants different text and data returns an MCP `CallToolResult`
with both, relayed as is.

`examples/demo-backend/server.mjs` does all three for `get_time`, in about
eighty lines including the view.

## What the client sees

| Where | The backend sends | The client receives |
|---|---|---|
| `tools/list`, `find_tools`, search mode | `ui: { resourceUri: "ui://clock" }` | `_meta.ui.resourceUri = "ui://demo/clock"`, next to the existing `_meta` |
| `tools/call` | a JSON object | the same text `content` + `structuredContent` |
| `resources/read` on `ui://demo/clock` | answers `read_resource { uri: "ui://clock" }` | `contents[]` under the published URI; `mimeType` and `_meta` as sent |
| `initialize`, `server/discover` | — | `capabilities.extensions["io.modelcontextprotocol/ui"]` |

The `ui://<backendId>/` prefix plays the role the `<backendId>_` prefix plays
for tool names: two backends can use the same path, and routing never has to
guess who owns a view.

Path segments are limited to letters, digits, `.`, `_`, `~` and `-`. A
`resourceUri` outside that shape is not published: the tool stays listed,
without its view.

## Rules the gateway enforces

- **No new path to a backend.** A call made from a view is an ordinary
  `tools/call`: same token, same scope check, same audit line.
  `visibility: ["app"]` asks the host to keep the tool away from the model; it
  lifts nothing. The gateway honors it where it speaks to the model itself:
  `find_tools` leaves such tools out.
- **A view is served to those who can call its tool.** `resources/read` on a
  `ui://` URI succeeds only if a federated tool of that backend declares that
  exact URI, and the caller holds the scope of one of the tools declaring it.
  Unknown backend, undeclared path, forged URI, missing scope: refused by the
  gateway, and the backend is never called.
- **`ui` is part of the tool's fingerprint.** Swapping the view of an
  approved tool, adding one, or moving a tool to `visibility: ["app"]` is a
  definition change: reported, and in `block` mode quarantined until an
  operator acknowledges it ([security.md §1](security.md)). A quarantined
  tool no longer opens its view.
- **`ui` is a reserved scheme.** No backend can claim it through a resource
  template.
- **Only the view that was asked for comes back.** Entries a backend returns
  under another URI are dropped; a missing `mimeType` reads as
  `text/html;profile=mcp-app`.

## What the gateway does not do

- It does not render, rewrite or inspect the HTML. Sandboxing and CSP are the
  host's job, driven by the `_meta.ui` the backend sends with the view.
- It does not fingerprint the view's **content**. A backend can change the
  HTML behind an unchanged `resourceUri` without tripping the integrity
  check — views legitimately change with every backend release, and a control
  that fires on each of them ends up switched off.
- **It does not confine a view to its own backend.** A host sees the gateway
  as one server, and a `tools/call` does not say which view sent it. A view
  can therefore ask the host to call *any* tool the user can call through the
  gateway — another backend's included, and tools marked
  `visibility: ["app"]` included — within the user's scopes, subject to
  whatever confirmation the host applies. Federating a backend that declares
  views means trusting its HTML to that extent. If that is too much for a
  given backend, do not let it declare views: review `ui` at approval time
  (integrity `block` mode quarantines a tool that gains one), or serve that
  backend from a gateway of its own.
- It does not relay `_meta` on tool results, only `content`,
  `structuredContent` and `isError`.
- It does not check what the connecting client announced: `_meta.ui` is sent
  to every client. A host without MCP Apps ignores it and shows the text.

## Native MCP servers (adapter)

A downstream server's `_meta.ui` crosses the adapter:

- `tools/list`: `_meta.ui.resourceUri` (and the deprecated flat
  `_meta["ui/resourceUri"]`) becomes the tool's `ui`. A URI already made of
  plain segments is kept (`ui://weather-server/dashboard` is published as
  `ui://<serverId>/weather-server/dashboard`); any other is carried
  base64url-encoded under `ui://<serverId>/b64/…`.
- `resources/read`: forwarded to the downstream server with the **calling
  user's** linked token, never the catalog account's. Only `ui://` crosses.
- `tools/call`: the downstream `CallToolResult` is relayed whole — text,
  images and `structuredContent` together.
- The adapter announces the extension in the `initialize` it sends
  downstream, since a server may register its view-enabled tools only for
  clients that do.

## Upgrading a gateway that runs integrity in `block` mode

Tools that declare no view keep their fingerprint: an existing baseline,
signed or not, still matches after the upgrade.

A federated native MCP server is different. If it already declared views, or
starts to once the adapter announces the extension, its tools gain `ui` at
the first catalog refresh after the upgrade. That is a definition change like
any other: those tools are quarantined until an operator reviews and
acknowledges them ([security.md §1](security.md)). Plan the acknowledgement
with the upgrade.
