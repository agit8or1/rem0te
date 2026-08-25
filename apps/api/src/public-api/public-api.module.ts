import { Module } from '@nestjs/common';
import { PublicApiController } from './public-api.controller';
import { ApiKeysModule } from '../apikeys/apikeys.module';
import { CustomersModule } from '../customers/customers.module';
import { UsersModule } from '../users/users.module';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { EnrollmentModule } from '../enrollment/enrollment.module';

@Module({
  imports: [ApiKeysModule, CustomersModule, UsersModule, EndpointsModule, EnrollmentModule],
  controllers: [PublicApiController],
})
export class PublicApiModule {}
