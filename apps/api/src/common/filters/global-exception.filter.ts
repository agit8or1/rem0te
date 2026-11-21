import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

/**
 * An error from express's body parser (body-parser / raw-body): it has a
 * 4xx `status` and a `type` such as `entity.too.large` or `entity.parse.failed`.
 */
function bodyParserError(e: unknown): e is { status: 400 | 413; type: string } {
  const x = e as { status?: unknown; type?: unknown } | null;
  return !!x && typeof x === 'object' && (x.status === 413 || x.status === 400) && typeof x.type === 'string' && /^(entity|request)\./.test(x.type);
}

/** Global search (0.33) — its query text is never logged. */
const SEARCH_PATH = /\/search\/?$/;

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code = 'INTERNAL_ERROR';
    // STEP_UP_REQUIRED names the action, so the client can say what is being
    // confirmed. Carried through only as a short identifier.
    let action: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
        // 0.82: a string response (the throttler's 429, for one) carries no
        // code of its own; it used to go out as INTERNAL_ERROR.
        code = this.statusToCode(status);
      } else if (typeof res === 'object' && res !== null) {
        const r = res as Record<string, unknown>;
        message = Array.isArray(r['message'])
          ? (r['message'] as string[]).join('; ')
          : ((r['message'] as string) ?? message);
        code = (r['code'] as string) ?? this.statusToCode(status);
        if (typeof r['action'] === 'string' && /^[a-z]+\.[a-z]+$/.test(r['action'])) action = r['action'];
      }
      code = code ?? this.statusToCode(status);
    } else if (bodyParserError(exception)) {
      // 0.82: express's body parser refuses a body before Nest sees it — over
      // the 1 MB JSON limit (413), or not JSON at all (400). Those were 500s.
      // The St0r push contract documents both (docs/st0r-push-contract.md).
      status = exception.status;
      code = status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST';
      message = status === 413 ? 'The request body is larger than this server accepts (1 MB of JSON).' : 'The request body is not valid JSON.';
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        message = 'A record with this value already exists';
        code = 'CONFLICT';
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        message = 'Record not found';
        code = 'NOT_FOUND';
      }
    }

    if (status >= 500) {
      // A search's query string is what someone was looking for (a person's
      // name, a serial, an address): the path alone is logged for it.
      const logged = SEARCH_PATH.test(request.path ?? '') ? request.path : request.url;
      this.logger.error(
        `${request.method} ${logged} → ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      code,
      message,
      ...(action ? { action } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private statusToCode(status: number): string {
    const map: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      413: 'PAYLOAD_TOO_LARGE',
      422: 'UNPROCESSABLE',
      429: 'TOO_MANY_REQUESTS',
      500: 'INTERNAL_ERROR',
    };
    return map[status] ?? 'ERROR';
  }
}
