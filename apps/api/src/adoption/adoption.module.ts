import { Module } from '@nestjs/common';
import { AdoptionController } from './adoption.controller';
import { AdoptionService } from './adoption.service';
import { DeploymentKeysService } from './deployment-keys.service';

// Discovery and adoption (0.57): the unassigned pool, assignment rules and
// deployment keys. Exports nothing — enrolment redeems a key by its hash in
// EnrollmentService, with the pure helpers in deployment-key.ts.
@Module({
  controllers: [AdoptionController],
  providers: [AdoptionService, DeploymentKeysService],
})
export class AdoptionModule {}
