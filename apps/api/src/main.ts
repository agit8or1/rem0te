import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? config.get<number>('API_PORT') ?? 3001;
  const frontendUrl = config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';
  const nodeEnv = config.get<string>('NODE_ENV') ?? 'development';

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
  console.log(`Reboot Remote API listening on http://127.0.0.1:${port}/api/v1`);
}

bootstrap().catch((err) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});
