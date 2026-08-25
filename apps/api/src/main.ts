import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from './app.module';

function readVersion(): { version: string; commit: string; buildDate: string } {
  let version = '0.0.0';
  try {
    const versionFile = process.env.VERSION_FILE ?? path.join(__dirname, '..', '..', '..', '..', 'version.json');
    if (fs.existsSync(versionFile)) {
      version = (JSON.parse(fs.readFileSync(versionFile, 'utf8')) as { version?: string }).version ?? version;
    }
  } catch { /* ignore */ }
  const commit = process.env.BUILD_COMMIT ?? 'unknown';
  const buildDate = process.env.BUILD_DATE ?? 'unknown';
  return { version, commit, buildDate };
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? config.get<number>('API_PORT') ?? 3001;
  const frontendUrl = config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';
  const nodeEnv = config.get<string>('NODE_ENV') ?? 'development';

  // Trusted-proxy configuration for req.ip resolution.
  //
  //   TRUSTED_PROXIES=loopback,linklocal,uniquelocal        # named ranges
  //   TRUSTED_PROXIES=10.0.0.0/8,127.0.0.1                  # explicit CIDRs
  //   TRUSTED_PROXIES=1                                     # trust the first hop only
  //   TRUSTED_PROXIES=false                                 # disable X-Forwarded-* trust
  //
  // Default: trust only loopback, matching a same-host Caddy/nginx reverse proxy.
  // NEVER default to `true` — that lets any client spoof X-Forwarded-For and bypass
  // GeoIP / rate-limiting / audit source-IP checks.
  const trustedProxies = process.env.TRUSTED_PROXIES ?? 'loopback';
  if (trustedProxies === 'false' || trustedProxies === '0') {
    app.set('trust proxy', false);
  } else if (/^\d+$/.test(trustedProxies)) {
    app.set('trust proxy', parseInt(trustedProxies, 10));
  } else if (trustedProxies.includes(',') || trustedProxies.includes('/')) {
    app.set('trust proxy', trustedProxies.split(',').map((s) => s.trim()).filter(Boolean));
  } else {
    app.set('trust proxy', trustedProxies);
  }

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: nodeEnv === 'production',
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Cookie parser (for access_token cookie)
  app.use(cookieParser());

  // CORS — allow frontend origin with credentials
  app.enableCors({
    origin: frontendUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global prefix
  app.setGlobalPrefix('api/v1');

  const httpServer = await app.listen(port, '127.0.0.1');
  // Node's default keepAliveTimeout is 5s — shorter than Caddy's connection pool.
  // Race condition: Caddy reuses a connection that Node just closed → 502.
  // Fix: set to 65s so Node outlasts the proxy's idle connection timeout.
  httpServer.keepAliveTimeout = 65000;
  httpServer.headersTimeout = 66000; // must be > keepAliveTimeout
  const v = readVersion();
  console.log(`Rem0te API v${v.version} (${v.commit}, built ${v.buildDate}) listening on http://127.0.0.1:${port}/api/v1`);
  console.log(`  trust proxy: ${trustedProxies} — configure TRUSTED_PROXIES if reverse proxy differs`);
}

bootstrap().catch((err) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});
