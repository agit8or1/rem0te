import { Global, Module } from '@nestjs/common';
import { RustdeskService } from './rustdesk.service';

/**
 * Global so the RustDesk coordinates and the client cache are reachable from
 * every surface that hands out a client — Quick Connect, the launcher, the
 * technician downloads page — without each one importing a module for it.
 */
@Global()
@Module({
  providers: [RustdeskService],
  exports: [RustdeskService],
})
export class CommonModule {}
