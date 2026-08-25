import { Injectable } from '@nestjs/common';
import { RoleType } from '@prisma/client';
import { actorHasPermission } from './permissions.map';

@Injectable()
export class RbacService {
  hasPermissions(
    actor: { isPlatformAdmin?: boolean; roleType?: RoleType | null; capabilities?: string[] | null },
    permissions: string[],
  ): boolean {
    return permissions.every((p) => actorHasPermission(actor, p));
  }
}
