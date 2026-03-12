import { IsOptional, IsString, IsIP } from 'class-validator';

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
}
