import { z } from 'zod';

const HEX64 = /^[0-9a-fA-F]{64}$/;
const ZERO_KEY = '0'.repeat(64);

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3001),
  API_PORT: z.coerce.number().default(3001),
  API_PREFIX: z.string().default('api'),
  JWT_SECRET: z.string().min(32).refine(
    (v) => v !== 'change_me' && !/^changeme/i.test(v),
    { message: 'JWT_SECRET is set to a placeholder value — generate a real 32+ byte random secret' },
  ),
  JWT_EXPIRES_IN: z.string().default('8h'),
  LAUNCHER_TOKEN_SECRET: z.string().min(16).refine(
    (v) => v !== 'change_me' && !/^changeme/i.test(v),
    { message: 'LAUNCHER_TOKEN_SECRET is set to a placeholder — generate a real random secret' },
  ),
  LAUNCHER_TOKEN_TTL_SECONDS: z.coerce.number().default(120),
  ENCRYPTION_KEY: z.string()
    .regex(HEX64, 'ENCRYPTION_KEY must be exactly 64 lowercase hex characters (32 bytes)')
    .refine(
      (v) => v.toLowerCase() !== ZERO_KEY,
      { message: 'ENCRYPTION_KEY is the placeholder all-zeros value — generate a real key: openssl rand -hex 32' },
    ),
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
