/**
 * A backup driver (0.81): how Rem0te READS one provider (transport `pull`).
 * The PsaDriver pattern (psa/connector.ts): one file per provider in
 * ./drivers, listed in DRIVERS, its kind in model.ts CONNECTION_KINDS and
 * migration 0097's CHECK.
 *
 * The only driver in 0.81 is the loopback stand-in. A real one (Comet, 4.4)
 * must:
 *   - reach its provider only through common/safe-https.ts (a public DNS
 *     name, resolved and judged on every call, TLS verified, no redirects,
 *     a bound and a size cap) — decision 17, no private addresses;
 *   - name its provider host only inside apps/api/src/backups/ (§91);
 *   - keep its credential sealed (common/secret-box.ts, purpose
 *     'rem0te-backup-credential-v1') and never put it in a view, audit row
 *     or log line;
 *   - return a feed that model.ts parseFeed accepts, and nothing else. It
 *     cannot say a job is verified: there is no such field.
 *
 * St0r PUSHES (decision 17), so it has no driver: its feed arrives at
 * POST /backups/push (backup-push.controller.ts).
 */
import type { BackupConnection } from '@prisma/client';
import type { ConnectionKind, FeedT } from './model';

export interface DriverDeps { encKey: string | undefined }

export type FetchResult = { ok: true; feed: FeedT } | { ok: false; code: string };

export interface BackupDriver {
  kind: ConnectionKind;
  /** Whether this driver can run in this process at all (the stand-in: only under NODE_ENV=test). */
  available(): { ok: true } | { ok: false; code: string };
  fetch(conn: BackupConnection, deps: DriverDeps): Promise<FetchResult>;
}
