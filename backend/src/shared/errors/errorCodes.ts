/**
 * Every error the API can return has a short, stable code.
 *
 * Why codes and not just messages: the Flutter app switches on the code
 * ("TOKEN_EXPIRED" -> silently refresh). Messages are for humans and can be
 * reworded any time; codes are a contract and must not change.
 */
export const ErrorCodes = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  EMAIL_ALREADY_EXISTS: "EMAIL_ALREADY_EXISTS",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  TOKEN_INVALID: "TOKEN_INVALID",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  OTP_INVALID: "OTP_INVALID",
  OTP_EXPIRED: "OTP_EXPIRED",
  OTP_ATTEMPTS_EXCEEDED: "OTP_ATTEMPTS_EXCEEDED",
  RATE_LIMITED: "RATE_LIMITED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  INTERNAL: "INTERNAL",
} as const;

// Union of the string values above: "VALIDATION_FAILED" | "EMAIL_ALREADY_EXISTS" | ...
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
