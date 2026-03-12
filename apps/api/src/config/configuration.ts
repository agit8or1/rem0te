import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3001),
  API_PORT: z.coerce.number().default(3001),
  API_PREFIX: z.string().default('api'),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('8h'),
  LAUNCHER_TOKEN_SECRET: z.string().min(16),
  LAUNCHER_TOKEN_TTL_SECONDS: z.coerce.number().default(120),
  ENCRYPTION_KEY: z.string().length(64),
  MFA_ISSUER: z.string().default('RebootRemote'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  PUBLIC_API_URL: z.string().default('http://localhost:3001'),
  APP_URL: z.string().default('http://localhost:3000'),
  CLAIM_TOKEN_TTL_HOURS: z.coerce.number().default(48),
  THROTTLE_TTL_SECONDS: z.coerce.number().default(60),
  THROTTLE_LIMIT: z.coerce.number().default(100),
  RUSTDESK_HOST: z.string().optional(),
  RUSTDESK_PUBLIC_KEY: z.string().optional(),
  COOKIE_SECURE: z.coerce.boolean().default(false),
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_TECH_EMAIL: z.string().email().optional(),
  SEED_TECH_PASSWORD: z.string().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

export function validateConfig(config: Record<string, unknown>): AppConfig {
  const result = configSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }
  return result.data;
}

export default (): AppConfig => validateConfig(process.env as Record<string, unknown>);
