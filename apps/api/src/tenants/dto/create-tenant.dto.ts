import {
  IsBoolean,
  IsEmail,
  IsHexColor,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class CreateTenantDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug must contain only lowercase letters, numbers, and hyphens',
  })
  slug: string;

  @IsOptional()
  @IsString()
  portalTitle?: string;

  @IsOptional()
  @IsUrl()
  logoUrl?: string;

  @IsOptional()
  @IsHexColor()
  accentColor?: string;

  @IsOptional()
  @IsEmail()
  supportEmail?: string;

  @IsOptional()
  @IsString()
  supportPhone?: string;

  @IsOptional()
  @IsBoolean()
  requireMfa?: boolean;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  sessionTimeoutMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(6)
  @Max(128)
  passwordMinLength?: number;

  @IsOptional()
  @IsString()
  rustdeskRelayHost?: string;

  @IsOptional()
  @IsString()
  rustdeskPublicKey?: string;
}

export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;
}

export class UpdateBrandingDto {
  @IsOptional()
  @IsString()
  portalTitle?: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;

  @IsOptional()
  @IsHexColor()
  accentColor?: string;

  @IsOptional()
  @IsEmail()
  supportEmail?: string;

  @IsOptional()
  @IsString()
  supportPhone?: string;

  @IsOptional()
  @IsString()
  footerText?: string;
}

export class UpdateSettingsDto {
  @IsOptional()
  @IsBoolean()
  requireMfa?: boolean;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  sessionTimeoutMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(6)
  @Max(128)
  passwordMinLength?: number;

  @IsOptional()
  @IsBoolean()
  allowPasswordReset?: boolean;

  @IsOptional()
  @IsString()
  rustdeskRelayHost?: string;

  @IsOptional()
  @IsString()
  rustdeskPublicKey?: string;

  @IsOptional()
  @IsBoolean()
  showDownloadPage?: boolean;

  @IsOptional()
  @IsBoolean()
  allowCustomerPortal?: boolean;
}
