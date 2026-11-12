import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { RetentionService } from './retention.service';

/**
 * Data retention status (0.34), for Settings → System status. Platform Admin
 * only: the counts are platform-wide (every business's rows), so there is no
 * business scope to narrow them to. Read-only: there is no route that runs,
 * changes or turns off the sweep — that is the server's environment.
 */
@Controller('admin/retention')
@UseGuards(JwtAuthGuard)
export class RetentionController {
  constructor(private readonly retention: RetentionService, private readonly acl: AccessControlService) {}

  /** Row count, oldest row and window per growing table; the sweep's state and last pass. `fresh=1` skips the 60 s cache. */
  @Get()
  async status(@Actor() actor: ActorContext, @Query('fresh') fresh?: string) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: await this.retention.status(fresh === '1') };
  }
}
