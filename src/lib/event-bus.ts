/**
 * In-process event bus for pushing SSE notifications to connected MCP clients.
 *
 * Simple pub/sub — each open SSE GET subscribes, receives unsolicited
 * JSON-RPC notifications (e.g. tools/list_changed) and unsubscribes on close.
 *
 * Known limits:
 * - In-process only (multi-instance deployments need a shared bus)
 * - No persistence: a reconnect is a fresh subscriber, no replay
 * - No Last-Event-ID support (events are best-effort)
 */

type Listener = (event: ServerEvent) => void;

export interface ServerEvent {
  /** JSON-RPC notification method (e.g. 'notifications/tools/list_changed'). */
  method: string;
  /** Optional params. */
  params?: unknown;
}

const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function broadcast(event: ServerEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[cortex/event-bus] listener error', err);
    }
  }
}

export function subscriberCount(): number {
  return listeners.size;
}
