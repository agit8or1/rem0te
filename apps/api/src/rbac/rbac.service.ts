import { Injectable } from '@nestjs/common';
import { RoleType } from '@prisma/client';
import { roleHasPermission } from './permissions.map';

@Injectable()
export class RbacService {
  async hasPermissions(
    roleType: RoleType,
    _tenantId: string,
    permissions: string[],
  ): Promise<boolean> {
    return permissions.every((p) => roleHasPermission(roleType, p));
  }
}
