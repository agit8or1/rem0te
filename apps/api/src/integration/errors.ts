import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

/**
 * Contract errors: `{ "error": { "code", "message" } }` and nothing else.
 * Codes are stable and documented in docs/contracts/ticket-rmm-v1/README.md;
 * messages are for humans and never echo request content.
 */
export class IntegrationError extends HttpException {
  constructor(status: number, public readonly code: string, message: string) {
    super({ code, message }, status);
  }
}

export const E = {
  notConfigured: () => new IntegrationError(404, 'NOT_CONFIGURED', 'Integration is not configured on this server'),
  unauthenticated: (m = 'Request signature invalid') => new IntegrationError(401, 'UNAUTHENTICATED', m),
  replay: (m = 'Nonce or token already used') => new IntegrationError(401, 'REPLAYED', m),
  delegation: (m: string) => new IntegrationError(401, 'DELEGATION_INVALID', m),
  forbidden: (m: string) => new IntegrationError(403, 'FORBIDDEN', m),
  notFound: () => new IntegrationError(404, 'NOT_FOUND', 'No such job'),
  invalid: (m: string) => new IntegrationError(400, 'INVALID_REQUEST', m),
  idempotencyConflict: () => new IntegrationError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key reused with a different payload'),
  tooLarge: () => new IntegrationError(413, 'TOO_LARGE', 'Request body too large'),
};

@Catch()
export class IntegrationExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Integration');
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof IntegrationError) {
      res.status(exception.getStatus()).json({ error: { code: exception.code, message: exception.message } });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status === 429 ? 'RATE_LIMITED' : status === 404 ? 'NOT_FOUND' : status === 413 ? 'TOO_LARGE' : status < 500 ? 'INVALID_REQUEST' : 'INTERNAL';
      res.status(status).json({ error: { code, message: status === 429 ? 'Too many requests' : 'Request refused' } });
      return;
    }
    this.logger.error('integration request failed', exception instanceof Error ? exception.stack : String(exception));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
  }
}
