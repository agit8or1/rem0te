import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

// Known scopes exposed via the public API. Keys can be minted with any
// subset; the guard enforces the required scope per route.
export const API_SCOPES = [
  'companies:read',   'companies:write',
  'users:read',       'users:write',
  'computers:read',   'computers:write',
  'sessions:read',
  'enrollment:write',
  'audit:read',
] as const;
export type ApiScope = typeof API_SCOPES[number];

// Key format: rk_<48-hex>. `rk_` prefix makes it easy to grep for leaked
// keys in logs / git history. First 12 chars are stored as `keyPrefix` for
// display; the full key is only ever returned to the operator ONCE (at
// creation) — server-side we keep a SHA-256 hash.
function generateKey(): { raw: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString('hex'); // 48 hex chars, ~192 bits
  const raw = `rk_${rand}`;
  const prefix = raw.slice(0, 12); // rk_xxxxxxxx
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, prefix, hash };
}

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(tenantId: string) {
    return this.prisma.apiKey.findMany({
      where: { tenantId },
      select: {
        id: true, name: true, keyPrefix: true, scopes: true,
        lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(tenantId: string, actorId: string, dto: { name: string; scopes: string[]; expiresInDays?: number }) {
    if (!dto.name || dto.name.length < 1) throw new BadRequestException('name required');
    const validScopes = dto.scopes.filter((s) => (API_SCOPES as readonly string[]).includes(s));
    if (validScopes.length === 0) throw new BadRequestException('at least one valid scope required');

    const { raw, prefix, hash } = generateKey();
    const expiresAt = dto.expiresInDays && dto.expiresInDays > 0
      ? new Date(Date.now() + dto.expiresInDays * 86400_000)
      : null;

    const record = await this.prisma.apiKey.create({
      data: {
        tenantId, createdById: actorId,
        name: dto.name.trim(),
        keyHash: hash, keyPrefix: prefix,
        scopes: validScopes,
        expiresAt,
      },
      select: { id: true, name: true, keyPrefix: true, scopes: true, expiresAt: true, createdAt: true },
    });

    await this.audit.log({
      tenantId, actorId,
      action: 'API_KEY_CREATED',
      resource: 'api_key', resourceId: record.id,
      meta: { name: record.name, scopes: validScopes },
    });

    // raw key returned ONCE — operator must save it
    return { ...record, key: raw };
  }

  async revoke(tenantId: string, id: string, actorId: string) {
    const row = await this.prisma.apiKey.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('API key not found');
    if (row.revokedAt) return { success: true, alreadyRevoked: true };
    await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit.log({
      tenantId, actorId,
      action: 'API_KEY_REVOKED',
      resource: 'api_key', resourceId: id,
      meta: { name: row.name },
    });
    return { success: true };
  }

  // Auth-guard entrypoint: given a raw `rk_...` header, resolve the tenant + scopes.
  async resolveBearer(rawKey: string) {
    if (!rawKey?.startsWith('rk_')) return null;
    const hash = createHash('sha256').update(rawKey).digest('hex');
    const row = await this.prisma.apiKey.findUnique({ where: { keyHash: hash } });
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt < new Date()) return null;

    // Best-effort touch — a background job could batch these to avoid a
    // write on every request, but volume is expected to be low.
    this.prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return {
      id: row.id,
      tenantId: row.tenantId,
      scopes: row.scopes,
      createdById: row.createdById,
    };
  }
}
