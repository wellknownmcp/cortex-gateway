<!-- https://cortex-gateway.dev/use-cases/twelve-apps-in-production/ -->

# Twelve internal apps behind one MCP connector

**TL;DR**

Cortex Gateway was extracted from a gateway that serves one company: **twelve internal applications, more than two hundred tools, one connector**. This page is what that deployment taught, with the numbers that can be published. The company is not named and no usage figures are given. The [company-federation page](/use-cases/company-federation/) is the worked example; this one is the field notes.

## The setting

One small application per function, each with its own database and its own rights: administration, sales, a document dataroom, quality management, finance, data protection, investor relations, code hosting, and a few more. Rights follow the org chart, and each application enforced them long before any agent existed.

The team has an MCP-capable assistant. The requirement was one sentence: **an agent may do what its user may do, in every application, and nothing else.**

|  | In this deployment |
| --- | --- |
| Applications federated | 12 |
| Tools, for an account holding every scope | more than 200 |
| Connectors a person installs | 1 |
| Credentials the gateway holds for the applications | 1 static token, accepted for catalog methods only |
| Full `tools/list`, before filtering | 42,000 tokens per conversation |

## What 42,000 tokens changed

Every tool definition is sent to the model at the start of a conversation. With two hundred of them, that measured 42,000 tokens before the user had typed a word. No protocol limit was reached. The cost was the model's attention, and its precision at picking the right tool.

Three things followed, all in the open-source gateway:

-   **Scope filtering first.** Two hundred is what an account with every scope sees. Most people hold the scopes of two or three applications, and their agent lists only those tools. A tool a user may not call is never described to their agent.
-   **A session can name its backends.** An agent working on the dataroom has no use for finance tools. It asks for the backends it needs, and the rest is not listed. This narrows the catalog and grants nothing: a call outside the list is still checked against the token.
-   **Search mode.** `tools/list` carries names and one-line descriptions; the full schema of a tool is fetched when the agent decides to use it. Details in [MCP: too many tools](/answers/mcp-too-many-tools/).

A smaller one came later: `tools/list` is sorted by name. The order used to follow each application's own list, so a release that reordered its tools changed the catalog the client had cached.

## What two hundred tools need besides schemas

A catalog tells an agent what it can call. It does not teach it the business. Past a few dozen tools, agents guess, and they guess wrong in ways that look plausible.

-   **Every application answers `get_help`.** Its workflows, its conventions and its vocabulary, written by the people who own it and versioned with its code. The gateway's instructions tell every agent to read it before guessing.
-   **Agents can say what is missing.** When an agent cannot do what it was asked, it files a ticket through a built-in tool instead of improvising. The backlog of unmet needs writes itself, per application.
-   **A refusal explains itself.** When an application refuses a call, its reason reaches the model as a tool error it can read and act on, not as an opaque failure.

## What stayed boring, on purpose

-   **The gateway decides nothing.** It checks that the agent does not exceed the scopes its user granted, and passes the user's identity on. Who may read which record is still decided where the record lives.
-   **Twelve applications, zero MCP libraries.** Each one answers a single HTTP endpoint. Adding the thirteenth is an endpoint and an environment variable.
-   **One audit line per call**, naming the person behind the agent, in one place.
-   **One revocation.** When someone leaves, their agent loses every application at once.

## What it took to keep it honest

In October 2026 the internal gateway went through a security review. Each finding was then checked against the open-source code. Those that applied were fixed in [v0.3.0](https://github.com/wellknownmcp/cortex-gateway/releases/tag/v0.3.0), and the one that could not be fixed in a release, the forwarding of the caller's token to backends, is [documented with what it implies](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/security.md).

The same month, the stateless MCP revision 2026-07-28 went live there next to the `initialize` path, on the same endpoint. Clients on the older revisions saw no difference, which was the point.

## What this page does not claim

-   **It is not the same code.** Cortex Gateway was extracted from that gateway in July 2026, and the two have lived separately since. The open-source one is generic and configured by environment; it also has parts the other does not need, such as the [adapter for third-party MCP servers](/guides/federate-third-party-mcp-servers/). The design is shared, and fixes travel both ways.
-   **No usage figures.** Number of users, calls per day and response times are not published here.
-   **One deployment is one deployment.** It shows the design holds at twelve applications for one organization. It says nothing about a hundred.

## If your situation looks like this

Several internal applications, a team already working with an assistant, and no wish to hand an aggregator the union of everyone's rights: the [worked example](/use-cases/company-federation/) shows the architecture, and the [repository](https://github.com/wellknownmcp/cortex-gateway) is MIT-licensed. If you would rather not do it alone, [this is work I take on](/about/).

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### How many tools can one MCP connector expose before it becomes a problem?

The limit is the model's context, not the protocol. Here, two hundred tools measured 42,000 tokens of `tools/list` per conversation before filtering. Scope filtering, per-session backend selection and a search mode brought that down.

### Does one connector mean every agent sees every tool?

No. The catalog is filtered by the scopes of the person the agent acts for. Two hundred is what an account with every scope sees; most people see the tools of two or three applications.

### Is Cortex Gateway the same code as the gateway described here?

No. It was extracted from it in July 2026 and the two have lived separately since. Same design, fixes in both directions.
