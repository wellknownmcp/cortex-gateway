/**
 * Transport policy for outbound backend URLs.
 *
 * Every federated call carries the caller's bearer token to the backend. Over
 * plaintext HTTP that token is readable by anything on the path — the single
 * cheapest way to turn a correct OAuth setup into a credential leak. So the
 * gateway refuses to speak plaintext to a remote host, rather than trusting
 * the operator to have gotten the scheme right in every environment.
 *
 * Allowed without ceremony:
 *  - any `https://` URL
 *  - `http://` to a loopback host (localhost, 127.0.0.0/8, ::1) — the stdio
 *    bridge and local development run there, and the traffic never leaves the
 *    machine
 *
 * Escape hatch: `CORTEX_ALLOW_INSECURE_BACKENDS=true` permits plaintext to
 * remote hosts and logs a warning on every load. Intended for a trusted
 * private network with its own transport security (a service mesh, a WireGuard
 * link) — not for production over the open internet.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(h) || h.startsWith('127.');
}

export function allowsInsecureBackends(): boolean {
  return process.env.CORTEX_ALLOW_INSECURE_BACKENDS === 'true';
}

/**
 * Returns the reason a URL is rejected, or null when it is acceptable.
 * `label` identifies the offending env var in the log.
 */
export function insecureUrlReason(raw: string, label: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${label}: not a valid absolute URL`;
  }

  if (url.protocol === 'https:') return null;
  if (url.protocol !== 'http:') {
    return `${label}: unsupported scheme "${url.protocol}" (expected https)`;
  }
  if (isLoopback(url.hostname)) return null;

  if (allowsInsecureBackends()) {
    // eslint-disable-next-line no-console
    console.warn(
      `[cortex/security] ${label} uses plaintext HTTP to a remote host — ` +
        'bearer tokens travel unencrypted. Allowed by CORTEX_ALLOW_INSECURE_BACKENDS=true.',
      { host: url.host },
    );
    return null;
  }

  return (
    `${label}: plaintext HTTP to remote host "${url.host}" refused — bearer tokens ` +
    'would travel unencrypted. Use https, or set CORTEX_ALLOW_INSECURE_BACKENDS=true ' +
    'if the transport is secured at another layer.'
  );
}

/**
 * Gate for registry loading: logs and rejects, without throwing.
 *
 * Dropping one misconfigured backend keeps the rest of the gateway serving —
 * failing closed on the insecure link, open on availability.
 */
export function acceptBackendUrl(raw: string, label: string): boolean {
  const reason = insecureUrlReason(raw, label);
  if (!reason) return true;
  // eslint-disable-next-line no-console
  console.error(`[cortex/security] backend skipped — ${reason}`);
  return false;
}
