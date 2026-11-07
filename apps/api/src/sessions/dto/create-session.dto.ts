import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

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

  /** Technician-entered work time. Kept apart from the measured duration. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24 * 60)
  manualWorkMinutes?: number;
}

export class SessionEventDto {
  @IsString()
  event!: string;

  @IsOptional()
  metadata?: Record<string, unknown>;
}
