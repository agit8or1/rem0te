import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** Ceilings for the two device endpoints (§93): a check-in is small; a command result (an app list) is not. */
export const CHECKIN_MAX_BYTES = 64 * 1024;
export const SERVER_MAX_BYTES = 2 * 1024 * 1024;

export type AppleRawRequest = Request & { appleRaw?: Buffer };

/**
 * The exact bytes a device sent, for Mdm-Signature (0.84, §93). Applied only
 * to AppleDeviceController's two PUT routes (MdmModule.configure). Devices
 * send `application/x-apple-aspen-mdm-checkin`, or no Content-Type at all,
 * so the global JSON parser never touches these bodies; this reads the
 * stream itself, bounded, and refuses anything over the ceiling with a 413
 * and no body. Nothing is parsed here: the signature is checked first, by
 * AppleMdmService, against these bytes.
 */
@Injectable()
export class AppleRawBodyMiddleware implements NestMiddleware {
  use(req: AppleRawRequest, res: Response, next: NextFunction) {
    const max = /\/checkin(?:\?|$)/.test(req.originalUrl) ? CHECKIN_MAX_BYTES : SERVER_MAX_BYTES;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) { res.status(413).end(); return; }
    // A parser that already ran (a JSON content type) kept the bytes: use those, never its result.
    const pre = (req as Request & { rawBody?: Buffer }).rawBody;
    if (Buffer.isBuffer(pre)) {
      if (pre.length > max) { res.status(413).end(); return; }
      req.appleRaw = pre;
      next();
      return;
    }
    if (req.readableEnded) { req.appleRaw = Buffer.alloc(0); next(); return; }
    const chunks: Buffer[] = [];
    let size = 0, done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) { done = true; res.status(413).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (done) return; done = true; req.appleRaw = Buffer.concat(chunks); next(); });
    req.on('error', () => { if (done) return; done = true; res.status(400).end(); });
  }
}
