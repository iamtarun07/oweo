import { ErrorCode, ErrorCodes } from "./errorCodes";

/**
 * The one error type the app throws on purpose.
 *
 * Anything thrown that is NOT an AppError is treated as a bug: the client gets
 * a generic 500 and the real details stay in the logs.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  /** true = we expected this (wrong password). false = a bug in our code. */
  readonly isOperational: boolean;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
    isOperational = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
    this.isOperational = isOperational;

    // Keeps the stack trace pointing at the call site, not at this constructor.
    Error.captureStackTrace(this, this.constructor);
  }

  // Static helpers so call sites read like sentences:
  //   throw AppError.unauthenticated();

  static validation(details: unknown, message = "Please check the highlighted fields.") {
    return new AppError(400, ErrorCodes.VALIDATION_FAILED, message, details);
  }

  static unauthenticated(message = "Please sign in to continue.") {
    return new AppError(401, ErrorCodes.UNAUTHENTICATED, message);
  }

  static invalidCredentials() {
    // Deliberately vague: the same message for "unknown email" and "wrong
    // password", so nobody can use this endpoint to discover who has an account.
    return new AppError(401, ErrorCodes.INVALID_CREDENTIALS, "Email or password is incorrect.");
  }

  static accountLocked(minutesLeft: number) {
    return new AppError(
      423,
      ErrorCodes.ACCOUNT_LOCKED,
      `Too many failed attempts. Try again in ${minutesLeft} minute(s).`
    );
  }

  static tokenInvalid(message = "This link or token is not valid.") {
    return new AppError(401, ErrorCodes.TOKEN_INVALID, message);
  }

  static tokenExpired(message = "This link or token has expired.") {
    return new AppError(401, ErrorCodes.TOKEN_EXPIRED, message);
  }

  static rateLimited(message: string) {
    return new AppError(429, ErrorCodes.RATE_LIMITED, message);
  }

  static notFound(message = "Not found.") {
    return new AppError(404, ErrorCodes.NOT_FOUND, message);
  }

  static conflict(code: ErrorCode, message: string) {
    return new AppError(409, code, message);
  }

  static internal(message = "Something went wrong. Please try again.") {
    return new AppError(500, ErrorCodes.INTERNAL, message, undefined, false);
  }
}
