import { IsBoolean, IsEmail, IsOptional, IsString } from 'class-validator';

export class CreateSessionDto {
  @IsOptional()
  @IsString()
  endpointId?: string;

  @IsOptional()
  @IsString()
  adHocRustdeskId?: string;

  @IsOptional()
  @IsBoolean()
  isAdHoc?: boolean;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  issueDescription?: string;
}

export class CompleteSessionDto {
  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  disposition?: string;
}

export class SessionEventDto {
  @IsString()
  event!: string;

  @IsOptional()
  metadata?: Record<string, unknown>;
}
