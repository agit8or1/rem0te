import * as https from 'https';

/**
 * The latest RustDesk client release, from GitHub, cached for an hour.
 *
 * This lived in three places — the installer templates, Quick Connect, and the
 * Updates page — each with its own cache, its own fallback constant, and its
 * own idea of what a valid tag looks like. They drifted: two of the fallbacks
 * were different versions, and only one of the three validated the tag before
 * caching it. The unvalidated one fed `rustdesk-${version}-x86_64.exe` download
 * URLs, so a single odd release tag (a `v` prefix, a `-rc1` suffix, an API
 * error body that still parses as JSON) would have been cached for an hour and
 * served to every installer and Quick Connect download in that window.
 *
 * One implementation, one cache, one fallback.
 */

const RELEASE_URL = 'https://api.github.com/repos/rustdesk/rustdesk/releases/latest';
const TAG_RE = /^\d+\.\d+\.\d+$/;
const CACHE_TTL_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Used only by callers that must name a concrete version — an installer script
 * or a client download — when GitHub has never been reachable this process.
 * Callers that can express "unknown" (the Updates page) should use
 * `latestRustdeskVersion()` and handle null instead of pinning to this.
 */
export const RUSTDESK_FALLBACK_VERSION = '1.4.9';

let cache: { version: string; fetchedAt: number } | null = null;

/** Latest release tag, or null if GitHub has not been reachable since boot. */
export function latestRustdeskVersion(): Promise<string | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return Promise.resolve(cache.version);
  }
  // A failed refresh keeps serving the last good value rather than falling back
  // to a hardcoded one: a stale-but-real version beats a wrong one.
  const stale = () => cache?.version ?? null;

  return new Promise((resolve) => {
    const req = https.get(
      RELEASE_URL,
      { headers: { 'User-Agent': 'reboot-remote', Accept: 'application/vnd.github.v3+json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const tag = String(JSON.parse(data).tag_name ?? '').replace(/^v/, '');
            if (!TAG_RE.test(tag)) return resolve(stale());
            cache = { version: tag, fetchedAt: Date.now() };
            resolve(tag);
          } catch {
            resolve(stale());
          }
        });
      },
    );
    req.on('error', () => resolve(stale()));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      resolve(stale());
    });
  });
}

/** As above, but never null — for callers that must name a version. */
export async function latestRustdeskVersionOr(
  fallback: string = RUSTDESK_FALLBACK_VERSION,
): Promise<string> {
  return (await latestRustdeskVersion()) ?? fallback;
}
