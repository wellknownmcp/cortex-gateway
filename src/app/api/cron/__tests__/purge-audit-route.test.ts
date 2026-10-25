import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/prisma', () => ({ isDatabaseConfigured: () => false, getPrismaCortex: () => ({}) }));

import * as route from '../purge-audit/route';

const URL_ = 'https://mcp.example.com/api/cron/purge-audit';

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('purge-audit', () => {
  it('accepts the secret in the header on POST', async () => {
    process.env.CRON_SECRET = 's3cret';
    const res = await route.POST(new NextRequest(URL_, { method: 'POST', headers: { 'x-cron-secret': 's3cret' } }));
    expect(res.status).toBe(200);
  });

  it('refuses the secret in the query string, a wrong secret, and an unset secret', async () => {
    process.env.CRON_SECRET = 's3cret';
    expect((await route.POST(new NextRequest(`${URL_}?secret=s3cret`, { method: 'POST' }))).status).toBe(401);
    expect((await route.POST(new NextRequest(URL_, { method: 'POST', headers: { 'x-cron-secret': 'nope' } }))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await route.POST(new NextRequest(URL_, { method: 'POST', headers: { 'x-cron-secret': '' } }))).status).toBe(401);
  });

  it('exposes no GET handler', () => {
    expect((route as Record<string, unknown>).GET).toBeUndefined();
  });
});
