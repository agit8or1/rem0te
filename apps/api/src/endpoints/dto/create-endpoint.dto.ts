import { IsString, IsOptional, IsBoolean, IsIn } from 'class-validator';

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
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() hostname?: string;
  @IsOptional() @IsString() platform?: string;
  @IsOptional() @IsString() osVersion?: string;
  @IsOptional() @IsString() ipAddress?: string;
  @IsOptional() @IsBoolean() isManaged?: boolean;
}

export class AddTagDto {
  @IsString() tag!: string;
}

export class AddAliasDto {
  @IsString() alias!: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}
