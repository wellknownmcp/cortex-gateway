<!-- https://cortex-gateway.dev/about/ -->

# About Cortex Gateway

**In short**

Cortex Gateway is built and maintained by one developer, [Anragde](https://github.com/Anragde) on GitHub. It was extracted from a gateway I built for a company, where it puts twelve internal applications behind one MCP connector. It is MIT-licensed and nothing here is for sale. If you want the same thing for your own applications, I take on that work: [opensource@wellknownmcp.org](mailto:opensource@wellknownmcp.org).

## Why it exists

My wife's company has one small internal application per function: administration, sales, a dataroom, and so on. Rights follow the org chart. When the team got a Claude plan, everyone wanted to hand their own agent the keys, with exactly their own rights. Nothing more, nothing less.

One MCP connector per application did not scale. An aggregator on a service account was the wrong answer: every agent would have held the union of everyone's access. So I built a gateway where the agent's access *is* the user's access. One connector for the company, every call carrying the real caller's identity, each application still enforcing the permissions it already had.

Later a post went around saying someone should build exactly that. It is what convinced me to extract the gateway from that stack and publish it.

## Where it runs

The gateway this project comes from federates twelve applications and more than two hundred tools for that company. What that taught, with the numbers I can publish, is in [twelve internal apps behind one MCP connector](/use-cases/twelve-apps-in-production/).

The two codebases are siblings, not copies. The open-source one is generic where the internal one is specific, and it has parts the internal one does not need, such as the adapter for third-party MCP servers. Fixes travel in both directions.

## What you can check

A project page can claim anything. These can be verified without taking my word for it:

-   **The official MCP conformance suite runs in CI**, against the production build and a real OAuth path. The scenarios that fail are listed with the reason, in [one file](https://github.com/wellknownmcp/cortex-gateway/blob/main/scripts/conformance/baseline.yml).
-   **The security document says what the gateway does not do**, control by control: [docs/security.md](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/security.md).
-   **The protocol layer is written by hand**, without an MCP SDK, for MCP 2026-07-28 and the three revisions before it, on the same endpoint.
-   **A hosted demo** answers at [mcp.cortex-gateway.dev](https://mcp.cortex-gateway.dev/), with its own OAuth 2.1 authorization server. Add it as a custom connector and read the tools your scopes allow.
-   **The release history** is public: [four releases](https://github.com/wellknownmcp/cortex-gateway/releases) since July 2026, each with upgrade notes.

## Working together

I help teams put their own applications behind MCP without giving up the permission model those applications already have. Typically:

-   making an existing application callable by agents, through one HTTP endpoint and no MCP library;
-   the OAuth 2.1 side that real clients are strict about: discovery, the 401 challenge, audience binding, an issuer behind a reverse proxy;
-   one connector for several applications, with scopes that mean something across them and an audit trail that names the person;
-   MCP Apps views, and what they change once several backends share an endpoint.

Write to [opensource@wellknownmcp.org](mailto:opensource@wellknownmcp.org) with what you have and what you want agents to reach. A bug or a question about the project itself belongs on [GitHub](https://github.com/wellknownmcp/cortex-gateway/issues); a vulnerability goes through a [private advisory](https://github.com/wellknownmcp/cortex-gateway/security/advisories/new).

[Get in touch →](mailto:opensource@wellknownmcp.org)
