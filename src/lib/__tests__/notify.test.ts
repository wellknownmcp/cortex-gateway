import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { notifyAdminOnBlocking } from '../notify';

const CTX = {
  ticketId: 't1',
  backend: 'cortex',
  source: 'cortex-local' as const,
  whatIWanted: 'A clickable link to a file',
  userIntent: 'Share the file with an external reviewer',
};

describe('notifyAdminOnBlocking', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CORTEX_TICKET_WEBHOOK_URL;
  });

  it('returns false without breaking when no webhook is configured', async () => {
    delete process.env.CORTEX_TICKET_WEBHOOK_URL;
    const ok = await notifyAdminOnBlocking(CTX);
    expect(ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('POSTs the ticket as JSON and returns true on 2xx', async () => {
    process.env.CORTEX_TICKET_WEBHOOK_URL = 'https://hooks.example.com/x';
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const ok = await notifyAdminOnBlocking(CTX);
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.example.com/x');
    const body = JSON.parse(init.body);
    expect(body.type).toBe('cortex.ticket.blocking');
    expect(body.ticketId).toBe('t1');
    expect(body.text).toContain('BLOCKING');
  });

  it('returns false on non-2xx', async () => {
    process.env.CORTEX_TICKET_WEBHOOK_URL = 'https://hooks.example.com/x';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const ok = await notifyAdminOnBlocking(CTX);
    expect(ok).toBe(false);
  });

  it('returns false on network error (best-effort, never throws)', async () => {
    process.env.CORTEX_TICKET_WEBHOOK_URL = 'https://hooks.example.com/x';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const ok = await notifyAdminOnBlocking(CTX);
    expect(ok).toBe(false);
  });
});
