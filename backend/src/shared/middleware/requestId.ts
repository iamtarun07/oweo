import { randomUUID } from "crypto";
import { Request, Response, NextFunction } from "express";

/**
 * Gives every request a unique id.
 *
 * Why: when something breaks, one request writes several log lines. Without an
 * id you cannot tell which lines belong together. The client also gets the id
 * back in a header, so a bug report can point at an exact request.
 */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const id = randomUUID();

  // res.locals is Express' own per-request storage bag. Later middleware
  // (logger, error handler) read the id from here.
  res.locals.requestId = id;

  res.setHeader("X-Request-Id", id);

  next();
}
