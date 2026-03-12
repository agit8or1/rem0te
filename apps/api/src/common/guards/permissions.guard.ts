import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { RbacService } from '../../rbac/rbac.service';
import type { JwtPayload } from '../../auth/strategies/jwt.strategy';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rbacService: RbacService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload;

    if (!user) throw new ForbiddenException('Not authenticated');
    if (user.isPlatformAdmin) return true;

    if (!user.tenantId || !user.roleType) {
      throw new ForbiddenException('No active tenant context');
    }

    const hasAll = await this.rbacService.hasPermissions(
      user.roleType,
      user.tenantId,
      required,
    );

    if (!hasAll) {
      throw new ForbiddenException(`Missing permissions: ${required.join(', ')}`);
    }

    return true;
  }
}
