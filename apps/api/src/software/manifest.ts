import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MANIFEST_MAX_BYTES, WINGET_PKGS_RAW, manifestPath, parseInstallerManifest, type InstallerManifest } from './definition';

/**
 * Reading a package's installer manifest from the public winget-pkgs
 * repository (0.34), so a catalog entry's pinned hash can say where it came
 * from. One bounded GET: no credentials, no cookies, no redirects followed,
 * 10 seconds, at most 256 KB, and the URL is built only from a
 * charset-checked package id and version.
 *
 * The hash read here is the portal's record of what the manifest said. It is
 * not what makes an install safe: each computer hashes the installer winget
 * downloads and refuses anything but the pinned value, and the approvers sign
 * that value (docs/software-deployment.md).
 *
 * WINGET_MANIFEST_BASE replaces the base only with a loopback http URL (the
 * end-to-end test's fixture server). Anything else is ignored: the server
 * never fetches a manifest from a host someone configured.
 */
export function manifestBase(): string {
  const o = process.env.WINGET_MANIFEST_BASE;
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored, one optional group with no nested quantifier over the same characters; read once from the environment
  if (o && /^http:\/\/127\.0\.0\.1:[0-9]{2,5}(\/[A-Za-z0-9._/-]*)?$/.test(o)) return o.replace(/\/+$/, '');
  return WINGET_PKGS_RAW;
}

export interface FetchedManifest { url: string; sha256: string; manifest: InstallerManifest }

export async function fetchInstallerManifest(packageId: string, version: string): Promise<FetchedManifest> {
  let rel: string;
  try { rel = manifestPath(packageId, version); } catch { throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Not a winget package id and version.' }); }
  const url = `${manifestBase()}/${rel}`;
  let r: Response;
  try {
    r = await fetch(url, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { accept: 'text/plain, application/x-yaml', 'user-agent': 'rem0te-software-catalog' }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new BadGatewayException({ code: 'MANIFEST_UNREACHABLE', message: 'The winget-pkgs repository did not answer. Try again, or paste the installer SHA-256 yourself.' });
  }
  if (r.status === 404) throw new NotFoundException({ code: 'MANIFEST_NOT_FOUND', message: `winget-pkgs has no manifest for ${packageId} ${version}. Check the id and the exact version.` });
  if (r.status !== 200 || !r.body) throw new BadGatewayException({ code: 'MANIFEST_UNREACHABLE', message: `winget-pkgs answered ${r.status}.` });
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MANIFEST_MAX_BYTES) { await reader.cancel().catch(() => undefined); throw new BadGatewayException({ code: 'MANIFEST_TOO_LARGE', message: 'The manifest is larger than 256 KB; it was not read.' }); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  const manifest = parseInstallerManifest(bytes.toString('utf8'));
  if (manifest.manifestType && manifest.manifestType !== 'installer') throw new BadGatewayException({ code: 'MANIFEST_UNREADABLE', message: 'That file is not an installer manifest.' });
  if ((manifest.packageIdentifier ?? '').toLowerCase() !== packageId.toLowerCase() || manifest.packageVersion !== version) {
    throw new BadGatewayException({ code: 'MANIFEST_MISMATCH', message: 'The manifest names a different package or version from the one asked for; it was not used.' });
  }
  if (!manifest.installers.length) throw new BadGatewayException({ code: 'MANIFEST_UNREADABLE', message: 'No installers could be read from the manifest. Paste the installer SHA-256 yourself.' });
  return { url, sha256: createHash('sha256').update(bytes).digest('hex'), manifest };
}
