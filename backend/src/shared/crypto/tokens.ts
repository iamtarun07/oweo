import { createHash, randomBytes, randomInt } from "crypto";

/**
 * Tokens use a FAST hash (SHA-256) while passwords use a slow one.
 *
 * Not a contradiction: a password is short and guessable, so slowness is the
 * defence. A 32-byte random token already has 256 bits of entropy — nobody is
 * guessing it, so slowing verification down would only slow us down.
 */

/** Random, URL-safe, unguessable. Used for verification and refresh tokens. */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** What we store in the database. The token itself is never stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A numeric one-time code.
 *
 * randomInt, never Math.random(): Math.random() is predictable, so an attacker
 * who sees a few codes could work out the next one.
 * padStart keeps "42" as "000042" — a leading zero is a valid code.
 */
export function generateNumericOtp(digits = 6): string {
  const max = 10 ** digits;
  return String(randomInt(0, max)).padStart(digits, "0");
}
