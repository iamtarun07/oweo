import { Request, Response, NextFunction } from "express";
import { logger } from "../logger";

/**
 * One log line per finished request, carrying the request id so every line
 * from the same request can be grepped together.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  // "finish" fires after the response is fully sent, which is the only moment
  // we know the status code and the total duration.
  res.on("finish", () => {
    logger.info(
      {
        requestId: res.locals.requestId,
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - start,
      },
      "request"
    );
  });

  next();
}
