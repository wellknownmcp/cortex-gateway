/**
 * MCP sessions (Mcp-Session-Id header) — in-memory, per process.
 *
 * MCP spec 2025-06-18 §Transport/Session Management:
 * - cryptographically secure id (UUID v4)
 * - visible ASCII 0x21-0x7E (UUID OK)
 * - the server may terminate a session at any time → 404 on calls carrying
 *   the old id
 * - clients send DELETE to terminate
 *
 * TTL: 24h (past that the client performs a new `initialize`).
 */

import { randomUUID } from 'node:crypto';

const TTL_MS = 24 * 60 * 60 * 1000;

interface Session {
  id: string;
  createdAt: number;
  sub: string;
  clientId: string;
  protocolVersion: string;
}

const sessions = new Map<string, Session>();

export function createSession(params: { sub: string; clientId: string; protocolVersion: string }): string {
  cleanExpired();
  const id = randomUUID();
  sessions.set(id, {
    id,
    createdAt: Date.now(),
    sub: params.sub,
    clientId: params.clientId,
    protocolVersion: params.protocolVersion,
  });
  return id;
}

export function validateSession(id: string | null | undefined): Session | null {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.createdAt > TTL_MS) {
    sessions.delete(id);
    return null;
  }
  return s;
}

export function terminateSession(id: string | null | undefined): void {
  if (id) sessions.delete(id);
}

function cleanExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > TTL_MS) sessions.delete(id);
  }
}
