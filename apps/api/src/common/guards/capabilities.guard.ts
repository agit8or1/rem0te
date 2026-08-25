import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CAPABILITIES_KEY } from '../decorators/require-capability.decorator';
import { buildActorContext } from '../../rbac/access-control.service';
import type { Capability } from '../../rbac/capabilities';
import type { JwtPayload } from '../../auth/strategies/jwt.strategy';

@Injectable()
export class CapabilitiesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Capability[]>(CAPABILITIES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload | undefined;
    if (!user) throw new ForbiddenException('Not authenticated');

    const actor = buildActorContext(user);
    if (actor.isPlatformAdmin) return true;

    const missing = required.filter((c) => !actor.capabilities.includes(c));
    if (missing.length > 0) {
      throw new ForbiddenException(`You do not have permission to do that (${missing.join(', ')})`);
    }
    return true;
  }
}
