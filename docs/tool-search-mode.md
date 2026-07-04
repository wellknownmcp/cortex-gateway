# Tool search mode

Federating many backends produces a big `tools/list`. Full JSON schemas for
50+ tools easily cost 20k+ tokens of agent context at session boot — most of
it never used. Two mitigations are built in, combinable:

## 1. Backend filtering — `X-Cortex-Backends`

```
X-Cortex-Backends: docs,billing
```

`tools/list` only returns the tools of the listed backends. Gateway builtins
(`whoami`, `report_missing_capability`, ...) always stay visible. An empty
value (`X-Cortex-Backends:`) lists builtins only.

Typical gain: 50–80% fewer tools in context when a session works on a known
subset, plus better tool-selection accuracy (less noise).

## 2. Search mode — `X-Cortex-Tool-Mode: search`

The Tool Search Tool pattern adapted to the MCP protocol. With the header:

- `tools/list` returns **compact entries**: name + one-line description +
  minimal `inputSchema` (`{ "type": "object" }`).
- An extra builtin appears: **`find_tools`**
  - `find_tools({ names: ["docs_search", ...] })` → full schemas for exact names
  - `find_tools({ query: "invoice" })` → fuzzy match on name+description, max 10

The agent scans the compact list, then loads full schemas on demand for the
2-3 tools it actually needs. Typical gain: ~80% on the `tools/list` payload.

Without the header, behaviour is unchanged (`normal` mode, full schemas) —
maximum compatibility with clients that pre-load the whole palette.

## Measuring

Every `tools/list` call is audited with `tools_listed`, `tokens_estimate`
(chars/4) , `backends_filter` and `tool_mode` — both in the stdout JSON lines
and, when a database is configured, in the `cortex_audit_trail` table. Use
them to compare before/after and to decide which mitigation your agents need.
