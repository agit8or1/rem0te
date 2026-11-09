import { IsIn, IsOptional, IsString } from 'class-validator';

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

  @IsOptional()
  @IsIn(['control', 'view_only', 'elevated', 'unattended'])
  mode?: 'control' | 'view_only' | 'elevated' | 'unattended';
}
