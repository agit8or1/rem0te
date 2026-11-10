import * as fs from 'node:fs';
import * as path from 'node:path';

/** The platform version, as main.ts finds it. Read per call; it is a small file. */
export function readVersion(): string {
  try {
    const f = process.env.VERSION_FILE ?? path.join(__dirname, '..', '..', '..', '..', '..', 'version.json');
    const v = (JSON.parse(fs.readFileSync(f, 'utf8')) as { version?: string }).version;
    return v && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v) ? v : 'unknown';
  } catch { return 'unknown'; }
}
