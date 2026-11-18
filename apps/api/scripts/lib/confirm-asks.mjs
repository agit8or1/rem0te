// Every "confirm it is you" function set to ask, for the suites that prove a
// step-up (0.64).
//
// Until 0.64 a fresh database had no ConfirmPolicy rows and every catalog
// function defaulted to `ask`, so the suites proved each step-up for free.
// From 0.64 every function defaults to `off` (the owner asked for "just on
// login"), so a suite that proves STEP_UP_REQUIRED must say it wants the
// confirmations on: an `ask` row for every catalog key, written before its API
// starts (the API reads the rows at start and every 30 s).
//
//   import { confirmEverythingAsks } from './lib/confirm-asks.mjs';
//   await confirmEverythingAsks(prisma);
//
// or, from run-e2e.sh, before any API starts:
//
//   node scripts/lib/confirm-asks.mjs
//
// The keys come from the built catalog (dist/security-controls/confirm-catalog.js),
// so a new catalog key is covered without touching this file. It refuses any
// database whose name does not contain "scratch" or "test": it writes policy.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

function catalogKeys() {
  for (const base of [path.join(here, '..', '..', 'dist'), path.join(here, '..', '..', 'dist', 'src')]) {
    try { return [...require(path.join(base, 'security-controls', 'confirm-catalog.js')).CONFIRM_KEYS]; } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error('dist/security-controls/confirm-catalog.js not found: run nest build first');
}

function refuseUnlessScratch() {
  const name = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
  if (!/scratch|test/.test(name)) throw new Error(`confirm-asks: refusing database "${name}": its name must contain "scratch" or "test"`);
}

/** Upsert an `ask` row for every catalog key. Returns how many keys. */
export async function confirmEverythingAsks(prisma) {
  refuseUnlessScratch();
  const keys = catalogKeys();
  await prisma.$transaction(keys.map((key) => prisma.confirmPolicy.upsert({ where: { key }, update: { value: 'ask' }, create: { key, value: 'ask' } })));
  return keys.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const n = await confirmEverythingAsks(prisma);
    console.log(`confirm policy: ${n} functions set to ask`);
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
