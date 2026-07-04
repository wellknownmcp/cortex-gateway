/**
 * Push notification to the platform team when an agent files a
 * `report_missing_capability` ticket with severity=blocking.
 *
 * Rationale: without a push, a blocking ticket lands silently in the triage
 * queue and users double up on external channels (chat, email) to make sure
 * someone sees it — losing the benefit of the traced, deduplicated internal
 * channel. An automatic notification closes the loop.
 *
 * Doctrine:
 *  - Only severity=blocking triggers a notification (inconvenient /
 *    nice_to_have stay in the normal triage queue, no spam).
 *  - Best-effort: if the notification fails, the ticket remains valid. Warn
 *    and keep going, never break the caller's response.
 *  - Transport: generic webhook (`CORTEX_TICKET_WEBHOOK_URL`). Point it at
 *    Slack/Discord/your own endpoint. The payload is plain JSON; adapt it
 *    with a thin receiver if your target needs a specific shape.
 */

export interface BlockingTicketContext {
  ticketId: string;
  backend: string; // 'cortex' (the gateway itself) or a federated backend id
  source: 'cortex-local' | 'backend-owned';
  whatIWanted: string;
  userIntent: string;
  contextTool?: string | null;
  contextApp?: string | null;
  suggestedShape?: string | null;
  agentEmail?: string | null;
  agentSub?: string | null;
}

/**
 * @returns true when the webhook was delivered (2xx), false otherwise.
 *          The return value only feeds logging and the `adminNotified` field
 *          in the ack message. Never make ticket creation depend on it.
 */
export async function notifyAdminOnBlocking(ctx: BlockingTicketContext): Promise<boolean> {
  const url = process.env.CORTEX_TICKET_WEBHOOK_URL;
  if (!url) {
    // eslint-disable-next-line no-console
    console.warn('[cortex/notify] CORTEX_TICKET_WEBHOOK_URL not set — blocking ticket notification skipped', {
      ticketId: ctx.ticketId,
      backend: ctx.backend,
    });
    return false;
  }

  const payload = {
    type: 'cortex.ticket.blocking',
    ticketId: ctx.ticketId,
    backend: ctx.backend,
    source: ctx.source,
    whatIWanted: ctx.whatIWanted,
    userIntent: ctx.userIntent,
    contextTool: ctx.contextTool ?? null,
    contextApp: ctx.contextApp ?? null,
    suggestedShape: ctx.suggestedShape ?? null,
    agent: ctx.agentEmail ?? ctx.agentSub ?? 'anonymous',
    // Convenience field for chat webhooks that render a `text` key (Slack...)
    text: `[cortex] BLOCKING ticket ${ctx.ticketId} on ${ctx.backend}: ${ctx.whatIWanted.slice(0, 140)}`,
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn('[cortex/notify] webhook returned non-2xx', {
        ticketId: ctx.ticketId,
        status: res.status,
      });
      return false;
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[cortex/notify] webhook send failed', {
      ticketId: ctx.ticketId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
