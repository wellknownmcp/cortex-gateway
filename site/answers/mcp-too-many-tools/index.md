<!-- https://cortex-gateway.dev/answers/mcp-too-many-tools/ -->

# Too many MCP tools: how `tools/list` eats your agent's context

**TL;DR**

Tool definitions are part of the prompt, so the entire catalog is re-sent on **every request**. Full JSON schemas for fifty-odd federated tools easily reach **20 000 tokens** at session boot, and most of them are never called. Worse than the cost is the noise: tool selection is a discrimination problem, and a federated catalog is full of near-duplicates. Three reductions compose — **scope filtering** (free, you owe it to least privilege anyway), **backend filtering** (50–80 % fewer tools), and a **compact `tools/list`** with schemas fetched on demand (~80 % of the payload). None of them deletes a tool.

## Why the catalog is a recurring tax, not a setup cost

A model has no memory of your tools between turns. Whatever it may call must be serialized into its context on each request: names, descriptions, JSON schemas, enums, nested objects. A tool that is never invoked still costs its full schema, every single turn, for the whole conversation.

This is the fact that makes federation dangerous. Connecting one application is fine. Connecting eight — each with a dozen honest, well-documented tools — produces a catalog nobody designed, and the agent pays for all of it before it does any work.

## The cost you don't see: selection accuracy

Tokens are the visible half. The invisible half is that the model must now *discriminate* between more options, and federated catalogs are adversarial by construction: different teams name the same operation `search`, `find`, `query`, `list`, and describe them in similar words. From the model's side these tools look interchangeable, and it picks by vibes.

So a smaller catalog is not merely cheaper. It is **more accurate**, and the accuracy gain arrives even when the token budget was never a constraint. If you take one thing from this page: shrinking the catalog is a correctness intervention wearing a performance costume.

## Measure before you cut

Guessing which application bloats the context is a good way to optimize the wrong one. Cortex Gateway audits every `tools/list` call with the four fields that answer the question:

| Field | What it tells you |
| --- | --- |
| `tools_listed` | How many tools this caller actually received, after scope filtering |
| `tokens_estimate` | Approximate context cost of the payload (characters ÷ 4) |
| `backends_filter` | Which applications the session asked for, if any |
| `tool_mode` | `normal` (full schemas) or `search` (compact) |

They land in the stdout JSON lines, and in the `cortex_audit_trail` table when a database is configured. Compare a session before and after each mitigation rather than trusting the percentages below — your catalog is not the one they were measured on.

## Reduction 1 — scope filtering (you already owe this)

The catalog is filtered by exact match between each tool's required scope and the scopes in the caller's token. A read-only user does not see the write tools. This is [least privilege](/guides/secure-mcp-with-oauth/), and it happens whether or not you care about context — but it is also, quietly, the first and cheapest reduction: a per-user catalog is smaller than the union of everyone's tools.

The corollary matters for design. Scopes that carve the catalog along the lines of what people actually do give you both security and a smaller prompt. Scopes that are all-or-nothing give you neither.

(If this filtering surprises you by removing *everything*, that is a different page: [why `tools/list` comes back empty](/answers/mcp-tools-list-empty/).)

## Reduction 2 — backend filtering, when the session knows its scope of work

Most sessions touch one or two applications. Say so, and the rest of the catalog never enters the context:

```
X-Cortex-Backends: docs,billing
```

`tools/list` then returns only the tools of those applications. Gateway builtins — `whoami`, `report_missing_capability` — always stay visible, because they are not attached to any backend. Typical gain: **50–80 % fewer tools**, plus the selection-accuracy improvement that comes with removing the noise.

One sharp edge, and it has bitten people: **an empty value is not "no filter"**. `X-Cortex-Backends:` with nothing after it means "no backends", and you get the builtins alone. A client that always sets the header from a config variable that happens to be empty asks for nothing and receives exactly that.

## Reduction 3 — compact catalog, schemas on demand

When the session does *not* know in advance which applications it needs, you cannot narrow the catalog — but you can stop paying for schemas nobody reads. This is the Tool Search Tool pattern, adapted to MCP:

```
X-Cortex-Tool-Mode: search
```

With that header, `tools/list` returns compact entries — name, a one-line description, and a minimal `inputSchema` of `{ "type": "object" }` — and one extra builtin appears:

```
find_tools({ names: ["docs_search_documents", "billing_get_invoice"] })  // exact, cheapest
find_tools({ query: "invoice" })                                        // fuzzy, max 10 results
```

The agent scans the compact list, picks the two or three tools it needs, and loads their full schemas. Typical gain on the `tools/list` payload: **~80 %**. The trade is one extra round trip before the first call, which is nearly free next to a model turn.

The two reductions compose: a programmatic agent that knows it works on `docs` can send both headers and pay for almost nothing.

## Compatibility is the default

Send no header and behaviour is unchanged: full schemas, one `tools/list`, maximum compatibility with clients that pre-load the whole palette and never call a resolver. That matters, because you do not control which client an employee plugs in. Both mitigations are opt-in, per request, and a client that ignores them still works.

## The reduction that isn't a header: design the catalog

Every mitigation above hides tools. None of them fixes a catalog that should not exist. Two anti-patterns produce most of the bloat.

**One tool per REST endpoint.** Generating the catalog from an OpenAPI document turns a hundred routes into a hundred tools that mirror your router rather than the agent's task. The unit of an MCP catalog is the task someone performs, not the resource your REST design happened to expose — the argument in full is on [exposing a REST API as an MCP server](/guides/rest-api-to-mcp-server/).

**The omnibus tool.** The overcorrection: collapse twelve tools into `do_thing({ action, ...params })`. The catalog shrinks and the schema becomes unreadable — the model must infer which parameters are legal for which action, with no types to guide it, and errors move from selection time to call time. It also breaks scope filtering, since one tool carries one required scope: your read-only user now sees a tool that can write. Fewer tools is the goal; one tool is a different failure.

Between the two: **coarse, task-shaped tools**, each spanning several internal calls if that is what the task means, each with a description that says *when* to use it rather than what it wraps.

## And when the agent still doesn't know what to do

A trimmed catalog tells an agent what it *can* call. It still doesn't teach it your domain — which sequence accomplishes anything, what a "workspace" means in your product. Shrinking `tools/list` by 80 % and then watching the agent flail is a real outcome. The missing half lives server-side, versioned with the application that owns it:

-   `<app>_get_help(topic?)` — concepts, the two to five workflows that matter, conventions, limits. Connected agents are instructed to prefer it over guessing, and it costs nothing until it is called.
-   `report_missing_capability` — when the agent hits a gap, it files a ticket instead of inventing a tool. Your backlog of unmet agent needs writes itself.

That is the honest resolution of the tension: a small catalog plus on-demand documentation beats a large catalog plus hope.

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### How many tools is too many for an MCP server?

There is no fixed number — the cost is tokens and selection accuracy, not tools. Full schemas for fifty-odd tools reach roughly 20 000 tokens at session boot, re-sent every turn, mostly unused. The practical test: when near-duplicate names and overlapping descriptions appear, the catalog is past its useful size whatever the count.

### Why do tool definitions cost tokens on every request?

The model has no memory of them between turns, so the whole catalog is serialized into context at each request. A tool that is never called still costs its schema every turn. A large `tools/list` is a recurring tax, not a setup cost.

### Does a bigger catalog make the agent worse at choosing tools?

Yes. Selection is discrimination, and every extra definition adds noise. Federated catalogs are the worst case: different applications call the same operation `search`, `find`, `query`, `list`. Reducing the catalog improves accuracy even when tokens were never a constraint.

### How do I shrink tools/list without removing tools?

Three composable reductions: scope filtering (free — least privilege already requires it), backend filtering via `X-Cortex-Backends` (50–80 % fewer tools), and search mode via `X-Cortex-Tool-Mode: search` (~80 % of the payload, schemas on demand). None deletes a tool; they change who sees what, and when.

### What is the Tool Search Tool pattern?

Return a compact catalog — names and one-line descriptions — plus one builtin that resolves full schemas on request. The agent scans, picks two or three tools, loads their schemas. In Cortex Gateway, `find_tools` accepts exact `names` or a fuzzy `query` (max 10 results).

### Should I merge tools into one tool with an action parameter?

No. You trade a legible catalog for an illegible schema, move errors from selection time to call time, and break scope filtering — one tool carries one scope, so read-only users see a tool that can write. Fewer, task-shaped tools; not one omnibus tool.

### Will these headers break clients that don't know them?

No. Both are opt-in and per request. Send nothing and you get the unchanged behaviour: full schemas, one `tools/list`. Clients that pre-load the whole palette keep working.

### My tools have no inputSchema. Is something broken?

You are in `search` mode. The compact entries carry a minimal `{ "type": "object" }` schema on purpose; call `find_tools` to get the real one.
