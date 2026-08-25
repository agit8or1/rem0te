import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { actorHasPermission } from '../../rbac/permissions.map';
import type { JwtPayload } from '../../auth/strategies/jwt.strategy';

/**
 * Evaluates the legacy `resource:action` permissions declared with
 * `@RequirePermissions()` against the three-level model. See
 * rbac/permissions.map.ts for the classification of each permission.
 *
 * This guard answers "may this actor perform this verb at all". It never
 * decides *which* business the verb lands on — handlers must additionally go
 * through AccessControlService.resolveScope().
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload | undefined;

    if (!user) throw new ForbiddenException('Not authenticated');
    if (user.isPlatformAdmin) return true;

    if (!user.roleType) {
      throw new ForbiddenException('No business context on this account');
    }

    const actor = {
      isPlatformAdmin: false,
      roleType: user.roleType,
      capabilities: user.capabilities ?? null,
      businessId: user.businessId ?? user.customerId ?? null,
    };

    const missing = required.filter((p) => !actorHasPermission(actor, p));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing permissions: ${missing.join(', ')}`);
    }

    return true;
  }
}
