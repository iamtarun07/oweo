import pino from "pino";
import { env } from "../infrastructure/config/env";

/**
 * One logger for the whole app.
 *
 * In development it prints coloured, readable lines (pino-pretty).
 * In production it prints JSON, because log services parse JSON, not colours.
 */
const isDev = env.NODE_ENV === "development";

export const logger = pino({
  level: env.LOG_LEVEL,

  // PRD SEC-2 / SEC-38: passwords, tokens and OTPs must NEVER reach a log file.
  // pino replaces these paths with "[Redacted]" before anything is written, so
  // even an accidental `logger.info({ body })` stays safe.
  redact: {
    paths: [
      "password",
      "newPassword",
      "otp",
      "token",
      "refreshToken",
      "accessToken",
      "authorization",
      "cookie",
      "*.password",
      "*.otp",
      "*.token",
      "*.refreshToken",
      "*.accessToken",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[Redacted]",
  },

  ...(isDev
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }
    : {}),
});
