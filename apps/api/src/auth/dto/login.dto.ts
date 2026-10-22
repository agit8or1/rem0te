import { IsEmail, IsString, MinLength, MaxLength, IsOptional, Length } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
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


/**
 * PATCH /auth/profile. This was an inline type, which ValidationPipe cannot
 * see, so the body went through unvalidated — any field, any length.
 */
export class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  // Required when `email` changes: the address is where a password reset
  // goes, so changing it is a takeover step and needs more than a session.
  @IsOptional() @IsString() @MaxLength(256) currentPassword?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(100) jobTitle?: string;
  @IsOptional() @IsString() @MaxLength(200) address?: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @IsString() @MaxLength(100) state?: string;
  @IsOptional() @IsString() @MaxLength(100) country?: string;
  @IsOptional() @IsString() @MaxLength(20) postalCode?: string;
  @IsOptional() @IsString() @MaxLength(64) timeZone?: string;
}

export class ChangePasswordDto {
  @IsString() @MinLength(1) @MaxLength(256) currentPassword!: string;
  @IsString() @MinLength(12) @MaxLength(256) newPassword!: string;
}
