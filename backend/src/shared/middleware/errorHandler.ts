import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

import { Prisma } from "../../generated/prisma/client";
import { AppError } from "../errors/AppError";
import { ErrorCodes } from "../errors/errorCodes";
import { logger } from "../logger";

/**
 * Nothing matched any route above -> our JSON 404, not Express' HTML page.
 * The Flutter app parses one shape; an HTML body would crash its parser.
 */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: {
      code: ErrorCodes.NOT_FOUND,
      message: "Route not found.",
      requestId: res.locals.requestId,
    },
  });
}

/**
 * The ONLY place an error becomes a response.
 *
 * Express recognises this as an error handler purely because it takes four
 * arguments. Remove `next` and Express silently treats it as normal middleware
 * and your errors stop being handled — a classic, very confusing bug.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  const requestId = res.locals.requestId;

  // 1. Errors we threw on purpose.
  if (err instanceof AppError) {
    logger.info({ requestId, code: err.code, msg: err.message }, "handled error");
    return send(res, err.statusCode, err.code, err.message, err.details, requestId);
  }

  // 2. Validation errors from zod, if one escaped the validate middleware.
  if (err instanceof ZodError) {
    return send(res, 400, ErrorCodes.VALIDATION_FAILED, "Please check the highlighted fields.", zodDetails(err), requestId);
  }

  // 3. Database errors Prisma names with a code.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return send(res, 409, ErrorCodes.CONFLICT, "That value is already taken.", undefined, requestId);
    }
    if (err.code === "P2025") {
      return send(res, 404, ErrorCodes.NOT_FOUND, "Not found.", undefined, requestId);
    }
  }

  // 4. Anything else is a bug. Log everything, tell the client nothing —
  //    an internal message can leak file paths, SQL, or secrets.
  logger.error({ requestId, err }, "unhandled error");
  return send(res, 500, ErrorCodes.INTERNAL, "Something went wrong. Please try again.", undefined, requestId);
}

/** Turns a ZodError into { fieldName: "message" } so the app can show it inline. */
export function zodDetails(err: ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  // PRD VR-U-8: report every bad field at once, not one per request.
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    if (!details[key]) details[key] = issue.message;
  }
  return details;
}

function send(
  res: Response,
  status: number,
  code: string,
  message: string,
  details: unknown,
  requestId: unknown
) {
  res.status(status).json({
    error: { code, message, ...(details !== undefined ? { details } : {}), requestId },
  });
}
