import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { JwtPayload } from '../../auth/strategies/jwt.strategy';

/**
 * Platform Admin, checked as a guard rather than inside the handler.
 *
 * Guards run before interceptors; a handler-body check does not. On the logo
 * upload that meant `FileInterceptor` had already written the file to disk by
 * the time the 403 was raised, so any signed-in user could fill the upload
 * directory two megabytes at a time and be told "no" each time.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user as JwtPayload | undefined;
    if (!user?.isPlatformAdmin) throw new ForbiddenException('Platform admin access required');
    return true;
  }
}
