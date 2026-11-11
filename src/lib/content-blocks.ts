/**
 * Well-formedness of MCP content blocks — shared by the gateway (which relays
 * a backend's CallToolResult only when every block is well formed) and the
 * adapter bridge (which hands one back only when the gateway will relay it).
 */

const isString = (v: unknown): v is string => typeof v === 'string';

/** True for a well-formed MCP content block (text, image, audio, resource, resource_link). */
export function isContentBlock(block: unknown): boolean {
  if (typeof block !== 'object' || block === null) return false;
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case 'text':
      return isString(b.text);
    case 'image':
    case 'audio':
      return isString(b.data) && isString(b.mimeType);
    case 'resource': {
      const r = b.resource as Record<string, unknown> | undefined;
      return typeof r === 'object' && r !== null && isString(r.uri) && (isString(r.text) || isString(r.blob));
    }
    case 'resource_link':
      return isString(b.uri) && isString(b.name);
    default:
      return false;
  }
}
