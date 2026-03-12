import { IsEmail, IsString, MinLength, IsOptional, Length } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;

  @IsOptional()
  @IsString()
  tenantSlug?: string;
}

export class VerifyMfaDto {
  @IsString()
  @Length(6, 16)
  code!: string;

  @IsOptional()
  @IsString()
  partialToken?: string;
}

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(12)
  password!: string;

  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;
}

export class SwitchTenantDto {
  @IsString()
  tenantSlug!: string;
}
