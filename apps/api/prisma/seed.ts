import { PrismaClient, RoleType, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const SYSTEM_ROLES: { name: string; type: RoleType }[] = [
  { name: 'Tenant Owner', type: RoleType.TENANT_OWNER },
  { name: 'Tenant Admin', type: RoleType.TENANT_ADMIN },
  { name: 'Technician', type: RoleType.TECHNICIAN },
  { name: 'Billing Admin', type: RoleType.BILLING_ADMIN },
  { name: 'Read Only', type: RoleType.READ_ONLY },
  { name: 'Customer Portal', type: RoleType.CUSTOMER },
];

async function main() {
  console.log('Seeding database...');

  // ── Platform admin user ──────────────────────────────────────────────────
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

  // ── Default tenant ───────────────────────────────────────────────────────
  // Create the initial tenant using env vars or defaults
  const tenantName = process.env.SEED_TENANT_NAME ?? 'My Organization';
  const tenantSlug = process.env.SEED_TENANT_SLUG ?? 'default';
  const rustdeskRelayHost = process.env.RUSTDESK_RELAY_HOST ?? null;
  const rustdeskPublicKey = process.env.RUSTDESK_PUBLIC_KEY ?? null;

  let tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) {
    tenant = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({
        data: {
          name: tenantName,
          slug: tenantSlug,
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
              portalTitle: `${tenantName} Support Portal`,
              accentColor: '#3B82F6',
            },
          },
        },
      });

      for (const role of SYSTEM_ROLES) {
        await tx.role.create({
          data: { tenantId: t.id, name: role.name, type: role.type, isSystem: true },
        });
      }

      return t;
    });
    console.log(`Tenant created: ${tenant.name} (${tenant.slug})`);
  } else {
    // Update RustDesk settings if they were just installed
    if (rustdeskRelayHost || rustdeskPublicKey) {
      await prisma.tenantSettings.updateMany({
        where: { tenantId: tenant.id },
        data: {
          ...(rustdeskRelayHost ? { rustdeskRelayHost } : {}),
          ...(rustdeskPublicKey ? { rustdeskPublicKey } : {}),
        },
      });
    }
    console.log(`Tenant exists: ${tenant.name}`);
  }

  // ── Owner membership for platform admin ─────────────────────────────────
  const ownerRole = await prisma.role.findFirst({
    where: { tenantId: tenant.id, type: RoleType.TENANT_OWNER },
  });

  if (ownerRole) {
    const existing = await prisma.membership.findFirst({
      where: { tenantId: tenant.id, userId: admin.id },
    });
    if (!existing) {
      await prisma.membership.create({
        data: { tenantId: tenant.id, userId: admin.id, roleId: ownerRole.id },
      });
      console.log(`Admin assigned as owner of ${tenant.name}`);
    }
  }

  console.log('\nSeed complete!');
  console.log(`  Platform admin: ${adminEmail} / ${adminPassword}`);
  console.log('  WARNING: Change the admin password after first login!');
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
