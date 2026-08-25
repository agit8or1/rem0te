import { IsOptional, IsString, IsIP, Length, Matches } from 'class-validator';

export class CreateClaimTokenDto {
  @IsOptional()
  @IsString()
  endpointId?: string;

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsString()
  siteName?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class HeartbeatDto {
  @IsString()
  @Matches(/^[0-9]{6,15}$/, { message: 'rustdeskId must be numeric' })
  rustdeskId!: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  hostname?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  platform?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  osVersion?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  agentVersion?: string;

  @IsOptional()
  @IsIP()
  ipAddress?: string;

  // Optional permanent password from the on-device installer. Stored
  // encrypted on the RustdeskNode so that when a platform admin later
  // assigns an unassigned device to a tenant, the tenant already has
  // the password without needing the customer to re-type it.
  @IsOptional()
  @IsString()
  @Length(1, 128)
  password?: string;
}

export class ClaimEndpointDto {
  @IsString()
  token!: string;

  @IsString()
  rustdeskId!: string;

  @IsOptional()
  @IsString()
  hostname?: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsString()
  osVersion?: string;

  @IsOptional()
  @IsString()
  agentVersion?: string;

  @IsOptional()
  @IsString()
  password?: string;
}
