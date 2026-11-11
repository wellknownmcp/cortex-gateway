/**
 * The bridge between a native MCP server and the backend contract, on the
 * MCP Apps path: `_meta.ui` of a downstream tool becomes `ui`, its view is
 * read with the caller's downstream token, and a tool result keeps both its
 * text and its structured part.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mcpListTools, mcpCallTool, mcpReadResource } = vi.hoisted(() => ({
  mcpListTools: vi.fn(),
  mcpCallTool: vi.fn(),
  mcpReadResource: vi.fn(),
}));
vi.mock('../mcp-client', () => ({ mcpListTools, mcpCallTool, mcpReadResource }));

import {
  bridgeCallTool,
  bridgeListTools,
  bridgeReadResource,
  BridgeToolError,
  toContractToolName,
  toDownstreamToolName,
  toDownstreamUiUri,
  toLocalUiUri,
} from '../backend-bridge';
import { publishUiUri, parsePublishedUiUri } from '@/lib/mcp-apps';
import type { McpServerConfig } from '../config';

const SERVER = { id: 'weather', url: 'https://weather.example/mcp', scope: 'mcp:weather:use' } as McpServerConfig;
const ODD_URI = 'ui://Weather Server/dashboard?v=2';

beforeEach(() => {
  mcpListTools.mockReset();
  mcpCallTool.mockReset();
  mcpReadResource.mockReset();
});

describe('view URIs of a third-party server', () => {
  it('a URI made of plain segments passes as is', () => {
    expect(toLocalUiUri('ui://weather-server/dashboard')).toBe('ui://weather-server/dashboard');
    expect(toDownstreamUiUri('ui://weather-server/dashboard')).toBe('ui://weather-server/dashboard');
  });

  it('any other ui:// URI travels encoded, and comes back identical', () => {
    for (const uri of [ODD_URI, 'ui://a/../b', 'ui://b64/looks-encoded', 'ui://weather/é']) {
      const local = toLocalUiUri(uri);
      expect(local, uri).toMatch(/^ui:\/\/b64\/[A-Za-z0-9_-]+$/);
      expect(toDownstreamUiUri(local), uri).toBe(uri);
      // And the gateway accepts the local form as a backend path.
      const published = publishUiUri('weather', local as string);
      expect(parsePublishedUiUri(published as string)).toEqual({ backendId: 'weather', backendUri: local });
    }
  });

  it('refuses what is not a ui:// URI, what is oversized, and what it did not encode itself', () => {
    expect(toLocalUiUri('https://weather.example/dashboard')).toBeNull();
    expect(toLocalUiUri(undefined)).toBeNull();
    expect(toLocalUiUri(`ui://${'a'.repeat(600)}`)).toBeNull();
    expect(toDownstreamUiUri('file:///etc/passwd')).toBeNull();
    // Decodes to something that is not a ui:// URI.
    expect(toDownstreamUiUri(`ui://b64/${Buffer.from('https://evil.example').toString('base64url')}`)).toBeNull();
    // Decodes to a URI the adapter would have passed as is: not its encoding.
    expect(toDownstreamUiUri(`ui://b64/${Buffer.from('ui://plain').toString('base64url')}`)).toBeNull();
    expect(toDownstreamUiUri('ui://b64/***')).toBeNull();
  });
});

describe('list_tools', () => {
  it('maps _meta.ui (nested and deprecated flat form) onto the contract', async () => {
    mcpListTools.mockResolvedValue([
      { name: 'get_weather', description: 'Weather.', _meta: { ui: { resourceUri: 'ui://weather-server/dashboard', visibility: ['model', 'app'] } } },
      { name: 'legacy_view', _meta: { 'ui/resourceUri': ODD_URI } },
      { name: 'refresh', _meta: { ui: { visibility: ['app'] } } },
      { name: 'plain', inputSchema: { type: 'object', properties: {} } },
      { name: 'not_a_view', _meta: { ui: { resourceUri: 'https://weather.example/x' } } },
    ]);
    const { tools } = await bridgeListTools(SERVER, 'downstream-token');
    const ui = Object.fromEntries(tools.map((t) => [t.name, t.ui]));
    expect(ui.get_weather).toEqual({ resourceUri: 'ui://weather-server/dashboard', visibility: ['model', 'app'] });
    expect(ui.legacy_view).toEqual({ resourceUri: toLocalUiUri(ODD_URI) });
    expect(ui.refresh).toEqual({ visibility: ['app'] });
    expect(ui.plain).toBeUndefined();
    expect(ui.not_a_view).toBeUndefined();
    expect(tools.every((t) => t.scope === 'mcp:weather:use')).toBe(true);
  });
});

describe('downstream tools named like a contract method', () => {
  it('are federated under an alias, reversibly, even when a name already looks like one', () => {
    for (const name of ['read_resource', 'whoami', 'list_tools', 'tool_read_resource', 'tool_tool_whoami']) {
      const federated = toContractToolName(name);
      expect(federated, name).toBe(`tool_${name}`);
      expect(toDownstreamToolName(federated), name).toBe(name);
    }
    for (const name of ['get_weather', 'tool_box', 'tool_', 'read_resources']) {
      expect(toContractToolName(name), name).toBe(name);
      expect(toDownstreamToolName(name), name).toBe(name);
    }
  });

  it('list_tools never hands the gateway a tool called read_resource, and the alias calls the real tool', async () => {
    mcpListTools.mockResolvedValue([{ name: 'read_resource' }, { name: 'get_weather' }]);
    const { tools } = await bridgeListTools(SERVER, 't');
    expect(tools.map((t) => t.name)).toEqual(['tool_read_resource', 'get_weather']);

    mcpCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    await bridgeCallTool(SERVER, 't', 'tool_read_resource', { uri: 'ui://anything' });
    expect(mcpCallTool).toHaveBeenCalledWith(SERVER.url, 't', 'read_resource', { uri: 'ui://anything' });
    expect(mcpReadResource).not.toHaveBeenCalled();
  });
});

describe('tool invocation', () => {
  it('hands back content and structuredContent together', async () => {
    const downstream = { content: [{ type: 'text', text: 'Sunny, 22°C' }], structuredContent: { temperature: 22 } };
    mcpCallTool.mockResolvedValue(downstream);
    expect(await bridgeCallTool(SERVER, 't', 'get_weather', { city: 'Paris' })).toEqual(downstream);
    expect(mcpCallTool).toHaveBeenCalledWith(SERVER.url, 't', 'get_weather', { city: 'Paris' });
  });

  it('keeps non-text blocks, and drops fields the contract does not carry', async () => {
    const content = [{ type: 'text', text: 'chart' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }];
    mcpCallTool.mockResolvedValue({ content, _meta: { trace: 'x' } });
    expect(await bridgeCallTool(SERVER, 't', 'chart', {})).toEqual({ content });
  });

  it('without content blocks, returns the structured part bare', async () => {
    mcpCallTool.mockResolvedValue({ content: [], structuredContent: { temperature: 22 } });
    expect(await bridgeCallTool(SERVER, 't', 'get_weather', {})).toEqual({ temperature: 22 });
  });

  it('a block the gateway would not relay: flattened as before, never the raw envelope', async () => {
    const odd = { type: 'resource_link', uri: 'https://weather.example/report' }; // no name
    mcpCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'Sunny' }, odd], structuredContent: { temperature: 22 } });
    expect(await bridgeCallTool(SERVER, 't', 'get_weather', {})).toEqual({ temperature: 22 });
    mcpCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'Sunny' }, { type: 'hologram' }] });
    expect(await bridgeCallTool(SERVER, 't', 'get_weather', {})).toBe('Sunny');
  });

  it('a downstream tool error stays an error', async () => {
    mcpCallTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'Unknown city' }] });
    await expect(bridgeCallTool(SERVER, 't', 'get_weather', {})).rejects.toThrow(new BridgeToolError('Unknown city'));
  });
});

describe('read_resource on a view', () => {
  it('reads the downstream URI with the given token and answers under the local URI', async () => {
    const local = toLocalUiUri(ODD_URI) as string;
    mcpReadResource.mockResolvedValue([
      { uri: ODD_URI, mimeType: 'text/html;profile=mcp-app', text: '<html></html>', _meta: { ui: { prefersBorder: true } }, extra: 1 },
    ]);
    expect(await bridgeReadResource(SERVER, 'user-token', local)).toEqual({
      contents: [{ uri: local, mimeType: 'text/html;profile=mcp-app', text: '<html></html>', _meta: { ui: { prefersBorder: true } } }],
    });
    expect(mcpReadResource).toHaveBeenCalledWith(SERVER.url, 'user-token', ODD_URI);
  });

  it('only ui:// crosses the adapter', async () => {
    for (const uri of ['file:///etc/passwd', 'https://weather.example/x', undefined, 'ui://b64/***']) {
      await expect(bridgeReadResource(SERVER, 't', uri)).rejects.toBeInstanceOf(BridgeToolError);
    }
    expect(mcpReadResource).not.toHaveBeenCalled();
  });
});
