import { Module } from '@nestjs/common';
import { DownloadsController } from './downloads.controller';

@Module({ controllers: [DownloadsController] })
export class DownloadsModule {}
