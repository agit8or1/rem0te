import { IsIn, IsObject, IsOptional, IsString, Length, Matches } from 'class-validator';

/**
 * The agent reporting on a diagnostic run (0.31): `running` before it starts,
 * then `completed` with a result or `failed` with an error. Device secret
 * required, like command-result. The result is re-shaped and capped in
 * diagnostics-catalog/catalog.ts before anything is stored.
 */
export class DiagnosticResultDto {
  @IsString()
  @Matches(/^[0-9]{6,15}$/, { message: 'rustdeskId must be numeric' })
  rustdeskId!: string;

  @IsString()
  @Length(16, 128)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'agentSecret must be URL-safe base64' })
  agentSecret!: string;

  @IsString()
  @Length(1, 64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  runId!: string;

  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,63}$/)
  key!: string;

  @IsIn(['running', 'completed', 'failed'])
  state!: 'running' | 'completed' | 'failed';

  @IsOptional() @IsObject() result?: Record<string, unknown>;
  @IsOptional() @IsString() @Length(0, 2000) error?: string;
}
