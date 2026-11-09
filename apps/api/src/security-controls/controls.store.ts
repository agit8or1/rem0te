import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AccessControls, BUILT_IN_PRESETS, BusinessControls, DEFAULT_CONTROLS, effectiveControls, presetCapabilities,
} from './presets';

/**
 * Reads and seeds the access policy and built-in presets. No cache: every
 * decision reads the current row, so a tightening takes effect on the next
 * request, as revocation does everywhere else in rem0te.
 */
@Injectable()
export class ControlsStore implements OnModuleInit {
  private readonly logger = new Logger('AccessControls');
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seed().catch((e) => this.logger.error(`seeding presets/policy failed: ${e}`));
  }

  /**
   * Idempotent: create what is missing, never overwrite. An admin's edits to
   * a built-in preset survive restarts and upgrades; "Reset defaults" is the
   * explicit way back.
   */
  async seed() {
    for (const p of BUILT_IN_PRESETS) {
      await this.prisma.technicianPreset.upsert({
        where: { key: p.key },
        create: {
          key: p.key, name: p.name, tier: p.tier, builtIn: true, description: p.description,
          capabilities: presetCapabilities(p.policy), policy: p.policy as unknown as Prisma.InputJsonValue,
        },
        update: {},
      });
    }
    await this.prisma.accessPolicy.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', controls: DEFAULT_CONTROLS as unknown as Prisma.InputJsonValue },
      update: {},
    });
  }

  async platform(): Promise<AccessControls> {
    const row = await this.prisma.accessPolicy.findUnique({ where: { id: 'singleton' } });
    if (!row) return DEFAULT_CONTROLS;
    // Merge over defaults so a field added in a later release has a value;
    // a stored policy that fails validation falls back to the shipped
    // defaults, which are the strict ones.
    const merged = { ...DEFAULT_CONTROLS, ...(row.controls as object), thresholds: { ...DEFAULT_CONTROLS.thresholds, ...((row.controls as { thresholds?: object }).thresholds ?? {}) } };
    const parsed = AccessControls.safeParse(merged);
    if (!parsed.success) { this.logger.error('stored access policy invalid — using defaults'); return DEFAULT_CONTROLS; }
    return parsed.data;
  }

  async business(customerId: string): Promise<BusinessControls | null> {
    const row = await this.prisma.accessPolicy.findUnique({ where: { customerId } });
    if (!row) return null;
    const parsed = BusinessControls.safeParse(row.controls);
    return parsed.success ? parsed.data : null;
  }

  async effective(customerId: string | null): Promise<AccessControls> {
    const platform = await this.platform();
    return customerId ? effectiveControls(platform, await this.business(customerId)) : platform;
  }
}
