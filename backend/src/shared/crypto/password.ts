import argon2 from "argon2";

/**
 * Password hashing with argon2id (PRD SEC-1).
 *
 * argon2id is "memory-hard": verifying costs real RAM, so an attacker with a
 * GPU farm cannot try billions of guesses per second the way they can with a
 * fast hash like SHA-256.
 */

// OWASP minimums, spelled out instead of relying on library defaults, so an
// upgrade later is one edit in one place.
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  // The salt is random per call and stored inside the returned string, so the
  // same password hashed twice gives two different hashes. That is correct.
  return argon2.hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // A malformed hash must return false, never throw. Throwing here would
    // take a different (faster) code path and leak information through timing.
    return false;
  }
}

/**
 * A real argon2 hash of a throwaway password, used by login when the email is
 * unknown: we still spend the ~200ms verifying, so "no such user" and "wrong
 * password" take the same time. See PRD SEC-4.
 */
export const DUMMY_PASSWORD_HASH_PROMISE = hashPassword("dummy-password-for-timing-equalisation");
