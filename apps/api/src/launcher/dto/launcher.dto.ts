import { IsOptional, IsString } from 'class-validator';

export class IssueLauncherTokenDto {
  @IsOptional()
  @IsString()
  endpointId?: string;

  @IsOptional()
  @IsString()
  adHocRustdeskId?: string;

  @IsOptional()
  @IsString()
  sessionId?: string;
}
