#!/usr/bin/env node
// portal-pin.mjs ENV_FILE — prints the RustDesk version the portal pins
// (PlatformSettings.rustdeskPinnedVersion, set on the Updates page), or
// nothing when there is no pin or the database cannot be read.
//
// One read-only SELECT through psql, with the password passed in the
// environment (never on a command line another user could see in ps). The
// portal itself picks "the pin, else the latest release" for the RustDesk
// build it offers (RustdeskService.pinnedOrLatestVersion); publishing the
// same build is what lets a signed agent install it.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = process.argv[2];
let text = '';
try { text = readFileSync(file, 'utf8'); } catch { process.exit(0); }
const line = text.split('\n').map((l) => l.trim()).find((l) => /^DATABASE_URL=/.test(l));
if (!line) process.exit(0);
let raw = line.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/, '$2');
let u;
try { u = new URL(raw); } catch { process.exit(0); }
if (!/^postgres(ql)?:$/.test(u.protocol)) process.exit(0);
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  PGHOST: decodeURIComponent(u.hostname || 'localhost'),
  PGPORT: u.port || '5432',
  PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password),
  PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
  PGCONNECT_TIMEOUT: '5',
};
const schema = u.searchParams.get('schema');
if (schema && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) env.PGOPTIONS = `-c search_path=${schema}`;
const sql = `SELECT "rustdeskPinnedVersion" FROM "PlatformSettings" WHERE id = 'singleton'`;
const r = spawnSync('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env, encoding: 'utf8', timeout: 15000 });
const v = (r.stdout ?? '').trim();
if (r.status === 0 && /^\d+\.\d+\.\d+$/.test(v)) console.log(v);
