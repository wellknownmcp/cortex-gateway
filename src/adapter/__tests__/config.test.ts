import { describe, it, expect, beforeEach } from 'vitest';
import { loadMcpServers, getMcpServer } from '../config';

describe('loadMcpServers', () => {
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CORTEX_MCP_')) delete process.env[key];
    }
    delete process.env.CORTEX_MCP_SERVERS;
  });

  it('returns an empty list when nothing is configured', () => {
    expect(loadMcpServers()).toEqual([]);
  });

  it('parses servers with defaults and overrides', () => {
    process.env.CORTEX_MCP_SERVERS = 'canva, figma';
    process.env.CORTEX_MCP_CANVA_URL = 'https://mcp.canva.com/mcp/';
    process.env.CORTEX_MCP_FIGMA_URL = 'https://mcp.figma.com/mcp';
    process.env.CORTEX_MCP_FIGMA_SCOPE = 'mcp:design:write';
    process.env.CORTEX_MCP_FIGMA_CLIENT_ID = 'client-abc';
    process.env.CORTEX_MCP_FIGMA_CATALOG_SUB = 'user-1';

    const servers = loadMcpServers();
    expect(servers).toHaveLength(2);
    expect(servers[0]).toMatchObject({
      id: 'canva',
      url: 'https://mcp.canva.com/mcp', // trailing slash stripped
      scope: 'mcp:canva:read', // default scope convention
    });
    expect(servers[1]).toMatchObject({
      id: 'figma',
      scope: 'mcp:design:write',
      clientId: 'client-abc',
      catalogSub: 'user-1',
    });
  });

  it('skips servers without a URL and resolves by id case-insensitively', () => {
    process.env.CORTEX_MCP_SERVERS = 'canva,ghost';
    process.env.CORTEX_MCP_CANVA_URL = 'https://mcp.canva.com/mcp';
    expect(loadMcpServers().map((s) => s.id)).toEqual(['canva']);
    expect(getMcpServer('CANVA')?.id).toBe('canva');
    expect(getMcpServer('ghost')).toBeNull();
  });
});
