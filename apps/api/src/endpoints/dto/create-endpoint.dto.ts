import { IsString, IsOptional, IsBoolean, IsIn, Length, Matches, MaxLength } from 'class-validator';

/** 0.68: a computer's nickname, its description and each alias. */
export const NAME_MAX = 100;
export const DESCRIPTION_MAX = 2000;
export const ALIAS_MAX = 64;
export const ALIASES_PER_COMPUTER = 20;

export class CreateEndpointDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() endpointGroupId?: string;
  @IsOptional() @IsString() hostname?: string;
  @IsOptional() @IsString() @IsIn(['windows', 'linux', 'macos', 'android', 'ios', 'other']) platform?: string;
  @IsOptional() @IsString() osVersion?: string;
  @IsOptional() @IsString() ipAddress?: string;
  @IsOptional() @IsString() macAddress?: string;
  @IsOptional() @IsString() serialNumber?: string;
  @IsOptional() @IsBoolean() isManaged?: boolean;
  @IsOptional() @IsString() rustdeskId?: string;
}

export class UpdateEndpointDto {
  // 0.68: the console's Rename sets these (the nickname and a short
  // description). Bounded here; the service trims and refuses a blank name.
  @IsOptional() @IsString() @Length(1, NAME_MAX) name?: string;
  @IsOptional() @IsString() @MaxLength(DESCRIPTION_MAX) description?: string;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() hostname?: string;
  @IsOptional() @IsString() platform?: string;
  @IsOptional() @IsString() osVersion?: string;
  @IsOptional() @IsString() ipAddress?: string;
  @IsOptional() @IsBoolean() isManaged?: boolean;
  @IsOptional() @IsString() aiTimeline?: string;
}

export class AddTagDto {
  @IsString() tag!: string;
}

export class AddAliasDto {
  @IsString() @Length(1, ALIAS_MAX) alias!: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

export class RedeemGrantDto {
  // 32 random bytes, hex — exactly what createConnectionGrant mints.
  @IsString() @Matches(/^[0-9a-f]{64}$/, { message: 'token is malformed' }) token!: string;
}

export class GrantAccessDto {
  @IsString() userId!: string;
  /** Optional access window and weekly schedule — see rbac/schedule.ts. */
  @IsOptional() @IsString() startsAt?: string | null;
  @IsOptional() @IsString() expiresAt?: string | null;
  @IsOptional() schedule?: unknown;
}
