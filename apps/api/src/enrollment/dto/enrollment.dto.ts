import { IsArray, IsEnum, IsOptional, IsString, IsIP, Length, Matches } from 'class-validator';

export enum EndpointAccessMode {
  ASSIGNED_USERS = 'ASSIGNED_USERS',
  COMPANY_WIDE   = 'COMPANY_WIDE',
}

export class CreateClaimTokenDto {
  @IsOptional() @IsString() endpointId?: string;
  @IsOptional() @IsString() customerName?: string;
  @IsOptional() @IsString() siteName?: string;
  @IsOptional() @IsString() @Length(0, 256) description?: string;

  // Managed-computer enrollment binding. All of these travel WITH the token
  // (server-side) so the machine that redeems it cannot pick a different
  // business or assign itself to a different user.
  //
  // `businessId` is the current name; `customerId` is still accepted so a
  // client mid-upgrade keeps working.
  @IsOptional() @IsString() businessId?: string;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsEnum(EndpointAccessMode) accessMode?: EndpointAccessMode;
  @IsOptional() @IsArray() @IsString({ each: true }) assignedUserIds?: string[];
  @IsOptional() @IsString() endpointGroupId?: string;
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

  // Installed RustDesk client version, e.g. "1.4.9". Drives the update
  // check on the Updates page and clears a staged update once the endpoint
  // reports the target version.
  @IsOptional()
  @IsString()
  @Length(1, 32)
  rustdeskVersion?: string;

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
