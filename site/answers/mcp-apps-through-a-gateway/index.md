<!-- https://cortex-gateway.dev/answers/mcp-apps-through-a-gateway/ -->

# MCP Apps through a gateway: what must be relayed

**TL;DR**

[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (extension `io.modelcontextprotocol/ui`) lets a tool come with an interactive view. Put a gateway or a proxy in front of the server and the view survives only if the gateway relays **four things**: `_meta.ui` on the tool, `resources/read` on the `ui://` resource, `structuredContent` in the result, and the extension in the capabilities. A gateway that predates the extension drops the first one, and **nothing fails**: the host shows text. Once several servers sit behind one endpoint, one consequence deserves to be said out loud: **a view can reach every tool the user can call**, not only the tools of the server that served it.

## The four things that have to pass

| Where | What the server sends | What usually happens in a gateway |
| --- | --- | --- |
| `tools/list` | `_meta.ui.resourceUri`, a `ui://` URI, and optionally `_meta.ui.visibility` | Tool definitions are rebuilt from the fields the gateway knows. `_meta` is not one of them. |
| `resources/read` | The view: one HTML document, `mimeType: text/html;profile=mcp-app`, with its CSP in `_meta.ui` | Resources are routed by scheme or not at all, and no server "owns" `ui`. |
| `tools/call` | `content` for the model, `structuredContent` for the view | The result is flattened to one text block. |
| `initialize` | The client announces the extension under `capabilities.extensions`; a server may register its view-enabled tools only for clients that do | The gateway is the client of the server behind it, and announces nothing. |

The last row is the easy one to miss when the gateway fronts a *native* MCP server. The specification says servers *should* check the client's capabilities before registering tools with views. The client that server sees is the gateway. If the gateway does not announce the extension downstream, a careful server hands it the text-only variants, and there is nothing left to relay.

## Diagnosing a view that does not render

In order, from the client's side of the gateway:

1.  **`tools/list`.** Does the tool carry `_meta.ui.resourceUri`? If not, stop here: the host has no reason to render anything.
2.  **`resources/read`** on that URI. An error, or an empty `contents`, means the gateway does not route `ui://`.
3.  **`tools/call`.** Is there a `structuredContent` next to `content`? A view with nothing to render looks like a view that failed.
4.  **The view's own CSP.** A host allows no external connection unless `_meta.ui.csp` on the resource declares the domain. That metadata has to cross the gateway too.

## Namespacing: two servers, one `ui://dashboard`

A gateway already solves this for tool names, usually with a prefix. View URIs need the same treatment, in both directions: publish each one under an identifier of the server that owns it, rewrite `_meta.ui.resourceUri` to match, and translate back when the host reads it.

```
backend "docs" declares      ui://preview
client sees, in tools/list   ui://docs/preview
client reads                 ui://docs/preview
backend "docs" is asked for  ui://preview
```

Routing on an identifier inside the URI has a second benefit: the gateway never has to decide which server owns the scheme. `ui` belongs to none of them, and should not be claimable by any.

## Who may read a view

The extension gives a view no scope of its own. Behind a gateway that filters tools by scope, the rule that follows is short: **the people who can call the tool are the people who can read its view.**

-   A view is served only if a federated tool declares that exact URI.
-   The caller must hold the scope of one of the tools declaring it.
-   Everything else is refused by the gateway itself: an undeclared path, a forged URI, a view of a backend the caller has no scope on. The backend is not called, so it never receives the token of a caller it has no business with.

That last point is the same discipline as for [resource reads in general](/answers/mcp-security-best-practices/): a gateway that forwards the caller's token must decide *before* forwarding.

## What a view can reach

A view calls tools by asking its host, and the extension scopes those calls to the server connection the view came from. With one server per connector, that is a real boundary: the weather view can call the weather server's tools.

Behind a gateway, the connection *is* the gateway. A `tools/call` does not say which view sent it, so the gateway cannot tell a call made by the model from a call made by a view, nor one backend's view from another's. Two consequences:

-   A view served by backend A can ask the host to call a tool of backend B, with the user's token and scopes.
-   `visibility: ["app"]` hides a tool from the model in a conforming host. It does not reserve the tool to the views of its own backend.

The ceiling is the user's own reach, plus whatever confirmation the host puts in front of a call: no scope is lifted, and every call lands in the same audit trail. But it is the user's *whole* reach, not the declaring backend's. Federating a backend that declares views means trusting its HTML to that extent, and it is a reason to look at `ui` when a tool is approved, not after.

## Pinning: the declaration, not the content

A gateway that [fingerprints tool definitions](/answers/mcp-security-best-practices/) to catch a rewrite after approval should include the `ui` block. Swapping the view behind an approved tool, adding one, or moving a write tool to `visibility: ["app"]` so the model no longer sees it are all changes of what was approved.

The HTML is another matter. It changes with every release of the backend, legitimately, behind an unchanged URI. A control that fires on each of those ends up switched off, which is worse than a limit stated plainly: the content of a view is the backend's, and the host's sandbox and CSP are what contain it.

## Concretely

[Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway) relays MCP Apps since 0.4.0, for backends that speak its [plain-HTTP contract](/guides/rest-api-to-mcp-server/) and for [native MCP servers](/guides/federate-third-party-mcp-servers/) alike. It builds no view. A backend adds `ui: { resourceUri: "ui://preview" }` to a tool and answers one more method; the gateway publishes the view as `ui://<backendId>/preview`, serves it under the scope of the declaring tool, adds `structuredContent` to the result, and counts `ui` in the tool's fingerprint. What it does not do is listed in the same document as what it does: [docs/mcp-apps.md](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/mcp-apps.md).

The relay is checked end to end in CI, against the production build and a real OAuth path, next to the official MCP conformance suite. The demo backend ships a small view for its `get_time` tool, about eighty lines including the HTML, as a starting point.

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### Do MCP Apps work through an MCP gateway or proxy?

Only if it relays four things: `_meta.ui` on each tool, `resources/read` on the `ui://` resource, `structuredContent` in the result, and the extension in the capabilities on both sides. A gateway written before the extension usually drops `_meta.ui`, and nothing fails: the host shows the text result and never asks for a view.

### Why does my MCP App show only text behind a gateway?

Look at `tools/list` as the client receives it. No `_meta.ui.resourceUri`: the gateway dropped it. If it is there, read the URI through the gateway; an error means `ui://` is not routed. If both work, check the result for `structuredContent`.

### How should a gateway namespace `ui://` resources?

Like tool names. Publish each URI under an identifier of the owning server (`ui://<backendId>/dashboard`), rewrite `_meta.ui.resourceUri` to match, and translate back on read.

### Who should be allowed to read a `ui://` resource?

The callers who can call a tool that declares it. Serve a view only when a federated tool declares that exact URI and the caller holds that tool's scope; refuse the rest without calling any backend.

### Can a view call tools from another server behind the same gateway?

Yes. The host sees the gateway as one server and a `tools/call` does not name the view that sent it. A view can ask for any tool the user can call, within the user's scopes. Trust a backend's views to that extent, or do not let that backend declare any.

### Does tool-definition pinning cover views?

The declaration, yes: `ui` belongs in the fingerprint. The HTML behind an unchanged URI, usually not, since it changes with every backend release.

### Does a host without MCP Apps break on `_meta.ui`?

No. Unknown `_meta` keys are ignored, and the extension requires every tool with a view to keep returning meaningful text. A client that does not render views shows that text.
