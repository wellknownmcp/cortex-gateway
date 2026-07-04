/**
 * Projects a downstream native MCP server onto the Cortex backend contract.
 *
 * Upstream (gateway → adapter): the simplified JSON-RPC backend contract.
 * Downstream (adapter → MCP server): real MCP over Streamable HTTP.
 *
 * V1 scope: tools only (list_tools + tool invocation) + whoami. Prompts and
 * resource templates return empty catalogs — the federator tolerates that.
 * Interactive MCP features (sampling, elicitation) do not cross the bridge.
 */

import type { CortexBackendTool } from '@/contract';
import type { McpServerConfig } from './config';
import { mcpListTools, mcpCallTool, type McpCallResult } from './mcp-client';

/** list_tools: downstream tools/list mapped onto the backend catalog shape. */
export async function bridgeListTools(
  server: McpServerConfig,
  token: string,
): Promise<{ tools: CortexBackendTool[] }> {
  const downstream = await mcpListTools(server.url, token);
  const tools: CortexBackendTool[] = downstream.map((t) => ({
    name: t.name,
    description: t.description ?? t.name,
    // Downstream tools declare no Cortex scope: the whole server gets the
    // scope configured for it (per-tool mapping can come later).
    scope: server.scope,
    // Propagated verbatim — the gateway prefers inputSchema when present.
    inputSchema: t.inputSchema ?? { type: 'object' },
  }));
  return { tools };
}

/**
 * Tool invocation: backend `method` → downstream `tools/call`.
 *
 * MCP returns { content: [...], isError?, structuredContent? }. The bridge
 * flattens it to what the gateway re-wraps as tool_result text:
 * - structuredContent when present (richest)
 * - joined text content otherwise
 */
export async function bridgeCallTool(
  server: McpServerConfig,
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const result: McpCallResult = await mcpCallTool(server.url, token, method, params);

  if (result.isError) {
    const text = extractText(result) || 'Downstream tool reported an error';
    throw new BridgeToolError(text);
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const text = extractText(result);
  return text !== '' ? text : result;
}

export class BridgeToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeToolError';
  }
}

function extractText(result: McpCallResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}
