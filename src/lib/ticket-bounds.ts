/**
 * Size bounds for `report_missing_capability` tickets. The text fields used to
 * be stored as received, forwarded to the owning backend and mailed to the
 * platform team for a blocking ticket: an agent stuck in a loop, or a verbose
 * one, filled the table and the inbox. Values are truncated, not refused — the
 * ticket keeps its signal, the excess is dropped.
 */

export const TICKET_FIELD_MAX = {
  whatIWanted: 2000,
  userIntent: 2000,
  suggestedShape: 4000,
  contextTool: 200,
  contextApp: 60,
} as const;

type TicketText = {
  whatIWanted?: string;
  userIntent?: string;
  suggestedShape?: string;
  contextTool?: string;
  contextApp?: string;
};

function cut(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (!v) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

export function boundTicketFields<T extends TicketText>(payload: T): T {
  return {
    ...payload,
    whatIWanted: cut(payload.whatIWanted, TICKET_FIELD_MAX.whatIWanted),
    userIntent: cut(payload.userIntent, TICKET_FIELD_MAX.userIntent),
    suggestedShape: cut(payload.suggestedShape, TICKET_FIELD_MAX.suggestedShape),
    contextTool: cut(payload.contextTool, TICKET_FIELD_MAX.contextTool),
    contextApp: cut(payload.contextApp, TICKET_FIELD_MAX.contextApp),
  };
}
