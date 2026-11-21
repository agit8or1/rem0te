/**
 * The typed parameters of the two diagnostics that take any (0.76): a copy of
 * apps/api/src/diagnostics-catalog/catalog.ts parseDiagnosticParams, for the
 * Diagnostics tab's DNS and TCP forms. Pure, no imports.
 *
 * The browser's check is a convenience — it says what is wrong before the
 * request is sent. The server checks again (and is the one that counts), the
 * database CHECKs the stored object (migration 0092), and the agent checks
 * the host name a fourth time before it uses it. §86 holds that this copy's
 * host-name pattern, timeouts and field lists agree with the API's.
 */

/** catalog.ts HOSTNAME_RE_SOURCE, character for character. */
export const HOSTNAME_RE_SOURCE = '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$';
const HOSTNAME_RE = new RegExp(HOSTNAME_RE_SOURCE);
export const HOSTNAME_MAX = 253;
export const TCP_TIMEOUTS = [1, 2, 3, 5, 10] as const;
export const DEFAULT_TCP_TIMEOUT = 5;
export const PARAM_FIELDS = { dns_lookup: ['name'], tcp_port: ['host', 'port', 'timeoutSeconds'] } as const;
export type ParamSchema = keyof typeof PARAM_FIELDS;

export type DiagnosticParams = { name: string } | { host: string; port: number; timeoutSeconds: number };
export type ParamsResult = { ok: true; params: DiagnosticParams | null } | { ok: false; error: string };

export function isHostName(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= HOSTNAME_MAX && !/[\r\n]/.test(v) && HOSTNAME_RE.test(v);
}

/**
 * The same rule as the API's, by schema rather than by catalog key (the web
 * holds no copy of the catalog: the entry's `params` comes from the server).
 * `schema` undefined is a key without parameters.
 */
export function parseDiagnosticParams(schema: ParamSchema | undefined, label: string, raw: unknown): ParamsResult {
  if (!schema) return raw === undefined || raw === null ? { ok: true, params: null } : { ok: false, error: `${label} takes no parameters.` };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return { ok: false, error: `${label} needs its parameters.` };
  const r = raw as Record<string, unknown>;
  const fields: readonly string[] = PARAM_FIELDS[schema];
  const extra = Object.keys(r).filter((k) => !fields.includes(k));
  if (extra.length) return { ok: false, error: `Unknown parameter: ${extra.slice(0, 3).join(', ').slice(0, 80)}.` };
  if (schema === 'dns_lookup') {
    if (!isHostName(r.name)) return { ok: false, error: 'The name must be a host name or IPv4 address: letters, digits, hyphens and dots, at most 253 characters.' };
    return { ok: true, params: { name: r.name } };
  }
  if (!isHostName(r.host)) return { ok: false, error: 'The host must be a host name or IPv4 address: letters, digits, hyphens and dots, at most 253 characters.' };
  if (typeof r.port !== 'number' || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) return { ok: false, error: 'The port must be a whole number from 1 to 65535.' };
  const to = r.timeoutSeconds === undefined ? DEFAULT_TCP_TIMEOUT : r.timeoutSeconds;
  if (typeof to !== 'number' || !(TCP_TIMEOUTS as readonly number[]).includes(to)) return { ok: false, error: `The timeout must be one of ${TCP_TIMEOUTS.join(', ')} seconds.` };
  return { ok: true, params: { host: r.host, port: r.port, timeoutSeconds: to } };
}

/** A form's port text as the API wants it: digits only, else NaN (refused by the parse). */
export function portFromText(t: string): number {
  return /^\d{1,5}$/.test(t.trim()) ? Number(t.trim()) : Number.NaN;
}

/** One line for a run's parameters, for the run detail and the history. */
export function paramsSummary(p: unknown): string | null {
  if (!p || typeof p !== 'object') return null;
  const r = p as Record<string, unknown>;
  if (typeof r.name === 'string') return r.name;
  if (typeof r.host === 'string' && typeof r.port === 'number') return `${r.host}:${r.port}${typeof r.timeoutSeconds === 'number' ? ` (${r.timeoutSeconds} s)` : ''}`;
  return null;
}
