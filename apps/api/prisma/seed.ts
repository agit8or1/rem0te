import { PrismaClient, RoleType, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

/**
 * The Rem0te authorization model has three levels. Platform Admin is a flag
 * on the User (`isPlatformAdmin`), not a Role row, so only the two business
 * levels are seeded here.
 */
const SYSTEM_ROLES: { name: string; type: RoleType; description: string }[] = [
  {
    name: 'Business Owner',
    type: RoleType.BUSINESS_OWNER,
    description: 'Full administrative control of a single business.',
  },
  {
    name: 'Business User',
    type: RoleType.BUSINESS_USER,
    description: 'Access limited to the capabilities granted by the Business Owner.',
  },
];

async function main() {
  console.log('Seeding database...');

  // ── Platform admin ────────────────────────────────────────────────────────
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@reboot-remote.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? generatePassword();
  const adminHash = await argon2.hash(adminPassword, { type: argon2.argon2id });

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash: adminHash,
      firstName: 'Platform',
      lastName: 'Admin',
      status: UserStatus.ACTIVE,
      isPlatformAdmin: true,
    },
  });
  console.log(`Platform admin: ${admin.email}`);

  // ── Platform container ────────────────────────────────────────────────────
  // Internal only. Businesses (Customer rows) are the security boundary and
  // are created by the operator from the Businesses screen.
  const platformName = process.env.SEED_TENANT_NAME ?? 'Rem0te';
  const platformSlug = process.env.SEED_TENANT_SLUG ?? 'default';
  const rustdeskRelayHost = process.env.RUSTDESK_RELAY_HOST ?? null;
  const rustdeskPublicKey = process.env.RUSTDESK_PUBLIC_KEY ?? null;

  let platform = await prisma.tenant.findUnique({ where: { slug: platformSlug } });
  if (!platform) {
    platform = await prisma.tenant.create({
      data: {
        name: platformName,
        slug: platformSlug,
        settings: {
          create: {
            requireMfa: false,
            sessionTimeoutMinutes: 480,
            passwordMinLength: 12,
            allowPasswordReset: true,
            rustdeskRelayHost,
            rustdeskPublicKey,
          },
        },
        branding: {
          create: {
            portalTitle: `${platformName} Remote Support`,
            accentColor: '#3B82F6',
          },
        },
      },
    });
    console.log(`Platform initialised: ${platform.name}`);
  } else {
    if (rustdeskRelayHost || rustdeskPublicKey) {
      await prisma.tenantSettings.updateMany({
        where: { tenantId: platform.id },
        data: {
          ...(rustdeskRelayHost ? { rustdeskRelayHost } : {}),
          ...(rustdeskPublicKey ? { rustdeskPublicKey } : {}),
        },
      });
    }
    console.log(`Platform exists: ${platform.name}`);
  }

  // ── System roles ──────────────────────────────────────────────────────────
  for (const role of SYSTEM_ROLES) {
    const existing = await prisma.role.findFirst({
      where: { tenantId: platform.id, type: role.type },
    });
    if (!existing) {
      await prisma.role.create({
        data: {
          tenantId: platform.id,
          name: role.name,
          type: role.type,
          description: role.description,
          isSystem: true,
        },
      });
      console.log(`Role created: ${role.name}`);
    }
  }

  // ── Platform settings ─────────────────────────────────────────────────────
  // Quick Connect ships OFF; the operator enables it deliberately.
  await prisma.platformSettings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  });

  console.log('\nSeed complete.');
  console.log(`  Platform admin: ${adminEmail} / ${adminPassword}`);
  console.log('  Change the admin password after first login.');
  console.log('  Next: create a Business, then add its Business Owner.');
}

function generatePassword(len = 20): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
