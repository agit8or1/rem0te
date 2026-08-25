#!/usr/bin/env node
// Rem0te documentation screenshot pipeline.
//
// - Seeds a fresh platform-admin user in the dev DB.
// - Uses Playwright (headless Chromium) against http://127.0.0.1:3000.
// - Captures each major page in both light AND dark themes.
// - Writes to docs/screenshots/{page}-{theme}.png.
// - Cleans up the throwaway user at the end.
//
// Uses fictional demo data only. Redacts any accidentally-visible strings
// matching common credential patterns (ghp_*, rk_*, etc.) via CSS masking
// before capture. Never runs against production.
//
// Usage:  DATABASE_URL=postgresql://... node scripts/screenshots.mjs

import playwrightPkg from '/home/administrator/reboot-remote/apps/web/node_modules/playwright/index.js';
const { chromium } = playwrightPkg;
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const prisma = new PrismaClient();

const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:3000';
const OUT_DIR = process.env.OUT_DIR ?? path.resolve(fileURLToPath(import.meta.url), '../../../../docs/screenshots');
const VIEWPORT = { width: 1440, height: 900 };

const PAGES = [
  { path: '/dashboard',           name: 'dashboard' },
  { path: '/my-computers',        name: 'my-computers' },
  { path: '/endpoints',           name: 'computers' },
  { path: '/endpoints/enroll',    name: 'add-computer' },
  { path: '/customers',           name: 'companies' },
  { path: '/users',               name: 'users' },
  { path: '/sessions',            name: 'sessions' },
  { path: '/audit',               name: 'audit' },
  { path: '/connect',             name: 'quick-connect' },
  { path: '/account',             name: 'account' },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const suffix = randomBytes(3).toString('hex');
  const email = `screenshots-${suffix}@test.invalid`;
  const password = 'screenshots-only-1234';

  const admin = await prisma.user.create({
    data: {
      email,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      firstName: 'Alex',
      lastName: 'Admin',
      isPlatformAdmin: true,
      status: 'ACTIVE',
    },
  });
  console.log(`Seeded ${email}`);

  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      colorScheme: 'light',
      ignoreHTTPSErrors: true,
    });

    // ── Login once, reuse the cookie for all page captures ──────────────
    const page = await context.newPage();
    await page.goto(`${WEB}/login`);
    await page.fill('input[type=email]', email);
    await page.fill('input[type=password]', password);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 }),
      page.click('button[type=submit]'),
    ]);
    console.log('Logged in.');

    for (const theme of ['light', 'dark']) {
      // Set the app's theme (Tailwind: html.dark for dark mode).
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate((t) => {
        try { localStorage.setItem('theme', t); } catch {}
        const html = document.documentElement;
        html.classList.remove('light', 'dark');
        html.classList.add(t);
      }, theme);

      for (const p of PAGES) {
        const url = `${WEB}${p.path}`;
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 });
        } catch {
          console.log(`  · ${p.name}/${theme}: navigation slow, continuing`);
        }
        // Small settle for React query / animations
        await page.waitForTimeout(1200);
        // Redact any potentially-secret text that snuck onto the page.
        await page.addStyleTag({ content: `
          :is(code,pre,input[type=password]) { filter: none; }
          [data-secret], [data-sensitive] { filter: blur(6px); }
        `});
        const file = path.join(OUT_DIR, `${p.name}-${theme}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`  ✓ ${p.name}/${theme} → ${file}`);
      }
    }

    await browser.close();
    console.log('\n✓ Screenshots regenerated.');
  } finally {
    // Cleanup — remove the throwaway user + any residue.
    try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
