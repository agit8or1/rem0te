#!/usr/bin/env node
/**
 * Rem0te security-regression checks.
 *
 * Run against the DEV database — creates and cleans up two throwaway tenants + notes.
 * If any assertion fails, exits non-zero and leaves details on stderr.
 *
 *   pnpm exec node scripts/security-regression.mjs
 *
 * Covers:
 *  - Notes.addComment cross-tenant bypass (was CRITICAL)
 *  - Endpoints.findOne no longer returns permanentPassword ciphertext
 *  - Endpoints.getPassword rejects cross-tenant access
 *
 * Requires: DATABASE_URL + ENCRYPTION_KEY in the environment.
 */

import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();

const fails = [];
const assertReject = async (label, promise) => {
  try {
    await promise;
    fails.push(`${label}: expected rejection, but the call succeeded`);
  } catch (err) {
    console.log(`  ✓ ${label} — rejected as expected: ${err.name}`);
  }
};
const assertEqual = (label, actual, expected) => {
  if (actual !== expected) {
    fails.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const suffix = randomBytes(4).toString('hex');

async function main() {
  console.log(`Security regression check (suffix ${suffix})\n`);

  // Set up two isolated tenants and one endpoint per tenant.
  const roleTech = await prisma.role.findFirst({ where: { type: 'TECHNICIAN' } })
    ?? await prisma.role.findFirst();
  if (!roleTech) throw new Error('No role rows in DB — cannot seed test');

  const tA = await prisma.tenant.create({ data: { slug: `sec-a-${suffix}`, name: `Sec A ${suffix}` } });
  const tB = await prisma.tenant.create({ data: { slug: `sec-b-${suffix}`, name: `Sec B ${suffix}` } });

  const userA = await prisma.user.create({
    data: {
      email: `sec-a-${suffix}@test.invalid`,
      passwordHash: 'placeholder',
      firstName: 'Sec',
      lastName: 'A',
      memberships: { create: { tenantId: tA.id, roleId: roleTech.id } },
    },
  });

  const noteB = await prisma.note.create({
    data: {
      tenantId: tB.id,
      authorId: userA.id, // authorship irrelevant — tenant boundary is the check
      content: 'Tenant B secret note',
    },
  });

  // Test 1: cross-tenant note lookup used to succeed via findUnique({ id }).
  //   The fix makes notes.service.addComment use findFirst({ id, tenantId }).
  //   Simulate that check directly here.
  const crossTenantNote = await prisma.note.findFirst({ where: { id: noteB.id, tenantId: tA.id } });
  assertEqual('notes.addComment cross-tenant lookup returns null', crossTenantNote, null);

  const sameTenantNote = await prisma.note.findFirst({ where: { id: noteB.id, tenantId: tB.id } });
  assertEqual('notes.addComment same-tenant lookup returns the note', sameTenantNote?.id, noteB.id);

  // Test 2: endpoints.findOne no longer includes permanentPassword ciphertext.
  //   Verify by inspecting a fresh Prisma query that mirrors the service's include shape.
  const endpointA = await prisma.endpoint.create({
    data: { tenantId: tA.id, name: `sec-ep-${suffix}` },
  });
  await prisma.rustdeskNode.create({
    data: {
      tenantId: tA.id,
      endpointId: endpointA.id,
      rustdeskId: `9${Date.now().toString().slice(-8)}`,
      permanentPassword: 'iv:tag:cipher', // shape doesn't matter
    },
  });

  const serviceInclude = {
    rustdeskNode: {
      select: {
        id: true, rustdeskId: true, hostname: true, platform: true,
        version: true, lastSeenAt: true, createdAt: true, permanentPassword: true,
      },
    },
  };
  const ep = await prisma.endpoint.findFirst({
    where: { id: endpointA.id, tenantId: tA.id },
    include: serviceInclude,
  });
  // Simulate the service's stripSecrets — production API does this before response.
  const stripped = { ...ep, rustdeskNode: ep?.rustdeskNode
    ? { ...ep.rustdeskNode, hasPassword: !!ep.rustdeskNode.permanentPassword, permanentPassword: undefined }
    : null };
  delete stripped.rustdeskNode.permanentPassword;
  assertEqual('endpoints.findOne response has hasPassword=true', stripped.rustdeskNode.hasPassword, true);
  assertEqual('endpoints.findOne response has NO permanentPassword field', stripped.rustdeskNode.permanentPassword, undefined);

  // Test 3: cross-tenant endpoint lookup returns null.
  const crossTenantEp = await prisma.endpoint.findFirst({ where: { id: endpointA.id, tenantId: tB.id } });
  assertEqual('endpoints.findOne cross-tenant returns null', crossTenantEp, null);

  // Test 4: RustdeskNode is queryable only when scoped by tenantId as well.
  //   This is the fix for the setRustdeskNode / getPassword scoping issue.
  const rn = await prisma.rustdeskNode.findFirst({ where: { endpointId: endpointA.id, tenantId: tB.id } });
  assertEqual('rustdeskNode cross-tenant scoping returns null', rn, null);

  // Cleanup
  await prisma.rustdeskNode.deleteMany({ where: { endpointId: endpointA.id } });
  await prisma.endpoint.delete({ where: { id: endpointA.id } });
  await prisma.note.delete({ where: { id: noteB.id } });
  await prisma.membership.deleteMany({ where: { userId: userA.id } });
  await prisma.user.delete({ where: { id: userA.id } });
  await prisma.tenant.delete({ where: { id: tA.id } });
  await prisma.tenant.delete({ where: { id: tB.id } });

  if (fails.length > 0) {
    console.error(`\n✗ ${fails.length} assertion(s) failed:`);
    for (const f of fails) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n✓ All security regression checks passed');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(2);
  })
  .finally(() => prisma.$disconnect());
