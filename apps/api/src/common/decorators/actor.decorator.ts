import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { buildActorContext, type ActorContext } from '../../rbac/access-control.service';
import type { JwtPayload } from '../../auth/strategies/jwt.strategy';

/**
 * Resolves the caller into an {@link ActorContext} — identity plus the
 * business they are pinned to. Prefer this over `@CurrentUser()` for anything
 * business-scoped; it is what the isolation checks read.
 */
export const Actor = createParamDecorator((_data: unknown, ctx: ExecutionContext): ActorContext => {
  const request = ctx.switchToHttp().getRequest();
  const user = request.user as JwtPayload | undefined;
  if (!user) throw new UnauthorizedException('Not authenticated');

  const ip = (request.ip as string | undefined) ?? undefined;
  const userAgent = request.headers?.['user-agent'] as string | undefined;
  return buildActorContext(user, ip, userAgent);
});
