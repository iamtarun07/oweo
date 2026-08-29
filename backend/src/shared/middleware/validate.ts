import { Request, Response, NextFunction, RequestHandler } from "express";
import { ZodType } from "zod";

import { AppError } from "../errors/AppError";
import { zodDetails } from "./errorHandler";

type RequestPart = "body" | "query" | "params";

/**
 * One validation middleware, used by every endpoint.
 *
 * It does two jobs:
 *  1. Rejects bad input before it reaches the service, with ALL field errors
 *     at once (PRD VR-U-8) instead of one error per round trip.
 *  2. Replaces req[part] with zod's PARSED output, so the service receives
 *     trimmed, lowercased, typed data instead of raw strings.
 */
export function validate<T>(schema: ZodType<T>, part: RequestPart = "body"): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[part]);

    if (!result.success) {
      return next(AppError.validation(zodDetails(result.error)));
    }

    // req.query / req.params are getter-only in Express 5, so assigning
    // directly would throw. defineProperty replaces the value safely.
    Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true });
    next();
  };
}
