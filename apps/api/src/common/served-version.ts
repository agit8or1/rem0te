import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * The platform version a fresh standard Windows installer reports as its
 * agent version (0.36): VERSION_FILE, else PROJECT_ROOT/version.json, else
 * ./version.json — the same lookup the heartbeat's reinstall check has
 * always used (EnrollmentService.platformVersion). Read per call: an in-app
 * update rewrites the file. 'unknown' when it cannot be read.
 */
export function servedAgentVersion(): string {
  try {
    const file = process.env.VERSION_FILE ?? path.join(process.env.PROJECT_ROOT ?? process.cwd(), 'version.json');
    return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch { return 'unknown'; }
}
