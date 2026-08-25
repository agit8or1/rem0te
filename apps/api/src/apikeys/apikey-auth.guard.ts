import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeysService, ApiScope } from './apikeys.service';

// Route-level metadata for scope requirements. Applied via @RequireScopes(...).
export const API_SCOPES_KEY = 'api:scopes';

@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(private readonly svc: ApiKeysService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth = (req.headers.authorization || req.headers.Authorization || '') as string;
    const m = auth.match(/^Bearer\s+(rk_[a-f0-9]{40,64})$/i);
    if (!m) throw new UnauthorizedException('Missing or malformed API key');

    const resolved = await this.svc.resolveBearer(m[1]);
    if (!resolved) throw new UnauthorizedException('API key invalid, revoked, or expired');

    // Shape the request user like a JwtPayload so every downstream isolation
    // check behaves identically to an interactive session.
    //
    // A key acts as a Business Owner *inside its own business and nowhere
    // else*: never a Platform Admin, and always pinned to `businessId`, so
    // AccessControlService confines it exactly like a logged-in owner. What
    // the key may do within that business is further narrowed by its scopes.
    req.user = {
      sub: resolved.createdById,
      email: 'api-key',
      tenantId: resolved.tenantId,
      businessId: resolved.businessId,
      customerId: resolved.businessId,
      roleType: 'BUSINESS_OWNER',
      capabilities: [],
      isPlatformAdmin: false,
      mfaVerified: true,
      apiKey: true,
      apiKeyId: resolved.id,
      apiScopes: resolved.scopes,
    };

    // Enforce required scopes from @RequireScopes decorator.
    const required = this.reflector.getAllAndOverride<ApiScope[]>(API_SCOPES_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (required && required.length > 0) {
      const has = new Set(resolved.scopes);
      const missing = required.filter((s) => !has.has(s));
      if (missing.length > 0) {
        throw new UnauthorizedException(`Missing required scopes: ${missing.join(', ')}`);
      }
    }
    return true;
  }
}
