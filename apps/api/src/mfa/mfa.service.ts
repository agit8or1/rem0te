import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import * as qrcode from 'qrcode';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class MfaService {
  private readonly encKey: Buffer;
  // In-process per-user backoff for recovery-code attempts. Cleared on successful use.
  // Combined with the per-IP throttle on the controller, this ensures a single hostile
  // authenticated session cannot brute-force recovery codes even if IP throttling is bypassed.
  private readonly recoveryAttempts = new Map<string, { count: number; blockedUntil: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {
    const rawKey = config.get<string>('ENCRYPTION_KEY');
    if (!rawKey || !/^[0-9a-fA-F]{64}$/.test(rawKey) || rawKey.toLowerCase() === '0'.repeat(64)) {
      throw new Error('ENCRYPTION_KEY is missing or invalid — refusing to start. Set a 64-hex-char key.');
    }
    this.encKey = Buffer.from(rawKey, 'hex');
  }

  async generateTotpSetup(userId: string): Promise<{ secret: string; qrCodeUrl: string; otpauthUrl: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const secret = authenticator.generateSecret(20);
    const issuer = this.config.get<string>('MFA_ISSUER', 'RebootRemote');
    const otpauthUrl = authenticator.keyuri(user.email, issuer, secret);
    const qrCodeUrl = await qrcode.toDataURL(otpauthUrl);
    const encryptedSecret = this.encrypt(secret);

    const existing = await this.prisma.userMfaMethod.findFirst({
      where: { userId, type: 'TOTP' },
    });

    if (existing) {
      await this.prisma.userMfaMethod.update({
        where: { id: existing.id },
        data: { totpSecret: encryptedSecret, isActive: false },
      });
    } else {
      await this.prisma.userMfaMethod.create({
        data: { userId, type: 'TOTP', totpSecret: encryptedSecret, isActive: false },
      });
    }

    return { secret, qrCodeUrl, otpauthUrl };
  }

  async confirmTotpEnrollment(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const method = await this.prisma.userMfaMethod.findFirst({ where: { userId, type: 'TOTP' } });
    if (!method?.totpSecret) throw new BadRequestException('TOTP setup not initiated');

    const secret = this.decrypt(method.totpSecret);
    const valid = authenticator.verify({ token: code, secret });
    if (!valid) throw new BadRequestException('Invalid TOTP code');

    await this.prisma.userMfaMethod.update({ where: { id: method.id }, data: { isActive: true } });

    const recoveryCodes = await this.generateAndStoreRecoveryCodes(userId);

    await this.audit.log({ action: 'MFA_ENROLLED', actorId: userId, resource: 'user', resourceId: userId });

    return { recoveryCodes };
  }

  async verifyTotp(userId: string, code: string): Promise<boolean> {
    const method = await this.prisma.userMfaMethod.findFirst({
      where: { userId, type: 'TOTP', isActive: true },
    });
    if (!method?.totpSecret) return false;
    const secret = this.decrypt(method.totpSecret);
    return authenticator.verify({ token: code, secret });
  }

  async verifyRecoveryCode(userId: string, code: string): Promise<boolean> {
    const now = Date.now();
    const state = this.recoveryAttempts.get(userId);
    if (state && state.blockedUntil > now) {
      await this.audit.log({ action: 'RECOVERY_CODE_BLOCKED', actorId: userId, resource: 'user', resourceId: userId });
      return false;
    }

    const methods = await this.prisma.userMfaMethod.findMany({
      where: { userId, type: 'RECOVERY_CODE', isActive: true, usedAt: null },
    });

    for (const method of methods) {
      if (!method.codeHash) continue;
      const match = await argon2.verify(method.codeHash, code.toUpperCase());
      if (match) {
        await this.prisma.userMfaMethod.update({
          where: { id: method.id },
          data: { usedAt: new Date(), isActive: false },
        });
        this.recoveryAttempts.delete(userId);
        await this.audit.log({ action: 'RECOVERY_CODE_USED', actorId: userId, resource: 'user', resourceId: userId });
        return true;
      }
    }

    // Track failure. After 5 wrong attempts within 15 minutes, lock this user out
    // of the recovery-code path for 15 minutes.
    const next = state && state.blockedUntil > now - 15 * 60_000
      ? { count: state.count + 1, blockedUntil: state.blockedUntil }
      : { count: 1, blockedUntil: now + 15 * 60_000 };
    if (next.count >= 5) {
      next.blockedUntil = now + 15 * 60_000;
      await this.audit.log({ action: 'RECOVERY_CODE_LOCKOUT', actorId: userId, resource: 'user', resourceId: userId });
    }
    this.recoveryAttempts.set(userId, next);
    return false;
  }

  async resetTotp(userId: string, actorId: string): Promise<void> {
    await this.prisma.userMfaMethod.deleteMany({ where: { userId } });
    await this.audit.log({ action: 'MFA_RESET', actorId, resource: 'user', resourceId: userId });
  }

  async getTotpStatus(userId: string) {
    const totp = await this.prisma.userMfaMethod.findFirst({
      where: { userId, type: 'TOTP', isActive: true },
    });
    const recoveryCodesRemaining = await this.prisma.userMfaMethod.count({
      where: { userId, type: 'RECOVERY_CODE', isActive: true, usedAt: null },
    });
    return { enrolled: !!totp, recoveryCodesRemaining };
  }

  private async generateAndStoreRecoveryCodes(userId: string): Promise<string[]> {
    await this.prisma.userMfaMethod.deleteMany({ where: { userId, type: 'RECOVERY_CODE' } });
    const codes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const code = crypto.randomBytes(5).toString('hex').toUpperCase();
      codes.push(code);
      const codeHash = await argon2.hash(code, { type: argon2.argon2id });
      await this.prisma.userMfaMethod.create({
        data: { userId, type: 'RECOVERY_CODE', codeHash, isActive: true },
      });
    }
    return codes;
  }

  private encrypt(text: string): string {
    // 12 bytes is the GCM standard nonce length. The IV is stored with each
    // record, so anything written when this was 16 still decrypts.
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encKey, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  async disableTotp(userId: string, code: string): Promise<{ success: boolean }> {
    const method = await this.prisma.userMfaMethod.findFirst({ where: { userId, type: 'TOTP', isActive: true } });
    if (!method?.totpSecret) throw new BadRequestException('TOTP is not enabled');
    const secret = this.decrypt(method.totpSecret);
    if (!authenticator.verify({ token: code, secret })) throw new BadRequestException('Invalid TOTP code');
    await this.prisma.userMfaMethod.update({ where: { id: method.id }, data: { isActive: false } });
    await this.audit.log({ actorId: userId, action: 'MFA_RESET', resource: 'user', resourceId: userId, meta: { self: true } });
    return { success: true };
  }

  private decrypt(data: string): string {
    const [ivHex, authTagHex, encHex] = data.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(enc).toString('utf8') + decipher.final('utf8');
  }
}
