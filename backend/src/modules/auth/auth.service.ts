import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";

import type { User } from "../../generated/prisma/client";
import { env } from "../../infrastructure/config/env";
import { prisma } from "../../infrastructure/database/prisma";
import { mailer, passwordResetEmail, verificationEmail } from "../../infrastructure/email/mailer";
import { AppError } from "../../shared/errors/AppError";
import { ErrorCodes } from "../../shared/errors/errorCodes";
import { logger } from "../../shared/logger";
import { DUMMY_PASSWORD_HASH_PROMISE, hashPassword, verifyPassword } from "../../shared/crypto/password";
import { generateNumericOtp, generateOpaqueToken, hashToken } from "../../shared/crypto/tokens";
import { DAY_MS, HOUR_MS, MINUTE_MS, durationToSeconds, fromNow, minutesUntil } from "../../shared/utils/time";
import * as repo from "./auth.repository";
import type { LoginInput, RegisterInput, ResetPasswordInput, VerifyEmailInput } from "./auth.schemas";
import { AuthPayload, toPublicUser } from "./auth.types";

// ponytail: per-account lockout only. Per-origin limiting (PRD 29.5, SEC-29)
// needs Redis - Phase 9. Do not build an IP table in Postgres for this.

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * MINUTE_MS;
// One TTL for both codes. A six-digit code is only a million combinations, so a
// 24-hour window (which the old emailed LINK could afford) would be reckless.
// Five minutes, not ten: the screens state "Valid for 5 minutes" as fact.
const OTP_TTL_MS = 5 * MINUTE_MS;
const MAX_OTP_ATTEMPTS = 5;

/** Same wording for every branch of /forgot-password. See sendPasswordResetOtp. */
export const NEUTRAL_RESET_MESSAGE = "If an account exists for this email, we've sent a code.";

/** Same wording for every branch of /verify-email/resend. See resendVerificationOtp. */
export const NEUTRAL_VERIFICATION_MESSAGE = "If a signup is waiting for this email, we've sent a new code.";

// --- Tokens ----------------------------------------------------------------

/**
 * A short-lived JWT. It is not stored anywhere: the signature proves it is
 * genuine, and 15 minutes limits the damage if one is stolen. Storing it would
 * mean a database read on every single request, which is the thing JWTs avoid.
 */
function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.ACCESS_TOKEN_SECRET, {
    // env stores a readable "15m"; jsonwebtoken accepts a number of seconds,
    // which is one conversion instead of fighting its string types.
    expiresIn: durationToSeconds(env.ACCESS_TOKEN_TTL),
  });
}

/**
 * Start a new login chain: a fresh familyId plus the first refresh token in it.
 * Only the HASH is stored, so a database leak hands the attacker nothing usable.
 */
async function startSession(userId: string, userAgent?: string): Promise<string> {
  const refreshToken = generateOpaqueToken();
  await repo.createSession({
    userId,
    familyId: randomUUID(),
    tokenHash: hashToken(refreshToken),
    expiresAt: fromNow(env.REFRESH_TOKEN_TTL_DAYS * DAY_MS),
    ...(userAgent ? { userAgent } : {}),
  });
  return refreshToken;
}

function authPayload(user: User, refreshToken: string): AuthPayload {
  return { accessToken: signAccessToken(user.id), refreshToken, user: toPublicUser(user) };
}

/**
 * Send an email without letting a slow or broken mail provider affect the API
 * response. PRD FR-AUTH-06 / AC-A3: registration must succeed even when the
 * email cannot be delivered.
 */
function sendEmailInBackground(send: Promise<void>, context: string) {
  void send.catch((err) => logger.error({ err, context }, "email send failed"));
}

// --- Step 13: register -----------------------------------------------------

/**
 * Issue a signup code, subject to BR-AUTH-6: at most 1 per minute and 5 per day
 * for one address. The rows already carry createdAt, so counting them is the
 * whole rate limiter - no Redis needed.
 *
 * `onLimit` differs by caller: register tells the user to wait (they are staring
 * at the screen and deserve an answer), resend stays silent (it is a public
 * endpoint, and a 429 there would reveal that a signup exists for this address).
 */
async function issueSignupOtp(
  data: { email: string; firstName: string; lastName: string; passwordHash: string },
  context: string,
  onLimit: (message: string) => void
): Promise<void> {
  const now = new Date();

  const lastMinute = await repo.countPendingSignupsSince(data.email, new Date(now.getTime() - MINUTE_MS));
  if (lastMinute > 0) return onLimit("Please wait a minute before requesting another code.");

  const lastDay = await repo.countPendingSignupsSince(data.email, new Date(now.getTime() - DAY_MS));
  if (lastDay >= 5) return onLimit("Too many requests today. Please try again tomorrow.");

  const otp = generateNumericOtp();
  await repo.issuePendingSignup({
    ...data,
    otpHash: hashToken(otp),
    expiresAt: fromNow(OTP_TTL_MS, now),
  });

  // Never awaited: a slow or broken mail provider must not decide how long the
  // API takes to answer (PRD FR-AUTH-06 / AC-A3).
  sendEmailInBackground(mailer.send(verificationEmail(data.email, otp)), context);
}

/**
 * Step one of two. NOTHING is created in `User` here - only a PendingSignup row
 * holding the hashed password and the hashed code. The account itself is
 * inserted in verifyEmail, so abandoning the signup leaves no junk row and
 * never claims the address.
 *
 * The trade that comes with it: an unverified address is not reserved, so two
 * people can hold a pending signup for the same email at once. Whoever confirms
 * their code first gets the account; the other gets EMAIL_ALREADY_EXISTS at
 * verify time, decided by the unique index rather than by a check that could race.
 */
export async function register(input: RegisterInput): Promise<{ email: string }> {
  // Hashing FIRST, before we know whether the email is taken. If we returned
  // early on a duplicate, that path would answer in ~5ms while a new signup
  // takes ~200ms, and the difference alone tells an attacker which emails are
  // registered (PRD SEC-4).
  const passwordHash = await hashPassword(input.password);

  // Only a courtesy: with no INSERT into User here there is no unique index to
  // arbitrate yet, so this lookup cannot be the real defence and is not treated
  // as one. verifyEmail holds the authoritative check.
  if (await repo.findUserByEmail(input.email)) {
    throw AppError.conflict(ErrorCodes.EMAIL_ALREADY_EXISTS, "An account with this email already exists.");
  }

  await issueSignupOtp(
    { email: input.email, firstName: input.firstName, lastName: input.lastName, passwordHash },
    "verification",
    (message) => {
      throw AppError.rateLimited(message);
    }
  );

  return { email: input.email };
}

// --- Step 14: login --------------------------------------------------------

export async function login(input: LoginInput, userAgent?: string): Promise<AuthPayload> {
  const user = await repo.findUserByEmail(input.email);
  const now = new Date();

  if (!user) {
    // Verify against a throwaway hash anyway. Without this, "unknown email"
    // returns in milliseconds while "wrong password" takes ~200ms, and that gap
    // is a working list-of-our-users oracle (PRD AC-A7).
    await verifyPassword(input.password, await DUMMY_PASSWORD_HASH_PROMISE);
    throw AppError.invalidCredentials();
  }

  if (user.lockedUntil && user.lockedUntil > now) {
    throw AppError.accountLocked(minutesUntil(user.lockedUntil, now));
  }

  const ok = await verifyPassword(input.password, user.passwordHash);

  if (!ok) {
    // Five failures spread over three months should not lock anyone out, so a
    // counter older than the lock window starts again from zero.
    const stale =
      !user.lastFailedLoginAt || now.getTime() - user.lastFailedLoginAt.getTime() > LOCK_DURATION_MS;
    const attempts = (stale ? 0 : user.failedLoginAttempts) + 1;

    await repo.updateUser(user.id, {
      failedLoginAttempts: attempts,
      lastFailedLoginAt: now,
      // The lock is SET on the 5th failure but only REPORTED on the next
      // attempt (PRD AC-A8) - this attempt still answers INVALID_CREDENTIALS.
      ...(attempts >= MAX_LOGIN_ATTEMPTS ? { lockedUntil: fromNow(LOCK_DURATION_MS, now) } : {}),
    });

    throw AppError.invalidCredentials();
  }

  const fresh = await repo.updateUser(user.id, { failedLoginAttempts: 0, lockedUntil: null });
  const refreshToken = await startSession(fresh.id, userAgent);
  return authPayload(fresh, refreshToken);
}

// --- Step 16: refresh ------------------------------------------------------

/** Internal signal: someone else rotated this session first. Never leaves this file. */
class RaceLostError extends Error {}

export async function refresh(token: string, userAgent?: string): Promise<AuthPayload> {
  const session = await repo.findSessionByTokenHash(hashToken(token));

  // Every failure below returns the SAME generic 401. Telling the caller
  // whether a token was unknown, rotated or revoked would help an attacker
  // work out what they are holding.
  if (!session) throw AppError.tokenInvalid("Please sign in again.");

  // A token that was already rotated or revoked is being replayed. Someone has
  // a copy they should not have, so the whole chain dies - including the real
  // user's current token. Being logged out is the visible symptom of theft.
  if (session.revokedAt || session.rotatedAt) {
    await repo.revokeFamily(session.familyId);
    throw AppError.tokenInvalid("Please sign in again.");
  }

  if (session.expiresAt <= new Date()) throw AppError.tokenExpired("Please sign in again.");

  const newToken = generateOpaqueToken();

  try {
    await prisma.$transaction(async (tx) => {
      const created = await repo.createSession(
        {
          userId: session.userId,
          familyId: session.familyId, // same chain, new link
          tokenHash: hashToken(newToken),
          expiresAt: fromNow(env.REFRESH_TOKEN_TTL_DAYS * DAY_MS),
          ...(userAgent ? { userAgent } : {}),
        },
        tx
      );

      // Conditional update: only succeeds if rotatedAt is still null. Two
      // requests arriving with the same token cannot both get a 1 here.
      const rotated = await repo.markSessionRotated(session.id, created.id, tx);
      if (rotated === 0) throw new RaceLostError();
    });
  } catch (err) {
    if (err instanceof RaceLostError) {
      await repo.revokeFamily(session.familyId);
      throw AppError.tokenInvalid("Please sign in again.");
    }
    throw err;
  }

  const user = await repo.findUserById(session.userId);
  if (!user) throw AppError.tokenInvalid("Please sign in again.");

  return authPayload(user, newToken);
}

// --- Step 17: logout -------------------------------------------------------

export async function logout(userId: string, token: string): Promise<void> {
  const session = await repo.findSessionByTokenHash(hashToken(token));

  // Idempotent: logging out twice, or with a token that is already gone, is a
  // success. The user asked to be signed out and they are (PRD EC-C7).
  // Only this family is revoked - other devices must stay signed in (BR-AUTH-22).
  if (session && session.userId === userId) {
    await repo.revokeFamily(session.familyId);
  }
}

// --- Step 18: verify email -------------------------------------------------

/**
 * Step two of two, and the moment the account actually exists. The code checks
 * below are the same three limits that make six digits safe - five guesses, ten
 * minutes, and one use - because a million combinations is nothing without them.
 *
 * Deliberately NOT idempotent. Confirming the code consumes the row, so calling
 * this twice fails with OTP_INVALID. The tempting alternative - "the address is
 * already verified, so hand back tokens" - would sign anyone in who knows an
 * email address and no code at all.
 */
export async function verifyEmail(input: VerifyEmailInput, userAgent?: string): Promise<AuthPayload> {
  const pending = await repo.findLatestPendingSignup(input.email);
  // Same error as a wrong code: whether a signup is waiting for this address is
  // not something this endpoint should confirm.
  if (!pending) throw new AppError(400, ErrorCodes.OTP_INVALID, "That code is not valid.");

  if (pending.attemptCount >= MAX_OTP_ATTEMPTS) {
    await repo.consumePendingSignup(pending.id);
    throw new AppError(400, ErrorCodes.OTP_ATTEMPTS_EXCEEDED, "Too many wrong codes. Request a new one.");
  }

  if (pending.expiresAt <= new Date()) {
    throw new AppError(400, ErrorCodes.OTP_EXPIRED, "That code has expired. Request a new one.");
  }

  if (hashToken(input.otp) !== pending.otpHash) {
    // Counting the wrong guesses IS the brute-force defence. Six digits is only
    // a million combinations; without this counter a script cracks it in minutes.
    await repo.incrementPendingSignupAttempts(pending.id);
    throw new AppError(400, ErrorCodes.OTP_INVALID, "That code is not valid.");
  }

  let user: User;
  try {
    // One transaction: either the account exists AND the code is spent, or
    // neither happened. A code that survived a failed insert could be replayed.
    user = await prisma.$transaction(async (tx) => {
      const created = await repo.createUser(
        {
          email: pending.email,
          passwordHash: pending.passwordHash,
          firstName: pending.firstName,
          lastName: pending.lastName,
          // Verified at birth: the code just proved the address. There is no
          // window in which a User row exists with this left null.
          emailVerifiedAt: new Date(),
        },
        tx
      );
      await repo.consumePendingSignup(pending.id, tx);
      return created;
    });
  } catch (err) {
    // Someone else confirmed this address between register and now - two people
    // are allowed to hold a pending signup for one email (PRD EC-A1). We do not
    // SELECT first: both requests would pass that check. The unique index is the
    // only atomic judge, so we insert and translate its complaint.
    if (repo.isUniqueViolation(err, "email")) {
      throw AppError.conflict(ErrorCodes.EMAIL_ALREADY_EXISTS, "An account with this email already exists.");
    }
    throw err;
  }

  const refreshToken = await startSession(user.id, userAgent);
  return authPayload(user, refreshToken);
}

// --- Step 19: resend verification -----------------------------------------

/**
 * Sends a fresh code - or quietly does nothing - and says the same thing either
 * way. Unlike the old version this endpoint cannot require a Bearer token,
 * because the caller has no account yet, so it is public and must not become an
 * oracle for "is a signup waiting for this address?".
 *
 * Every `return` here produces a byte-identical response, INCLUDING the
 * rate-limited one. The cost is that a resend inside the one-minute window looks
 * like success and sends nothing, so the client must show the usual countdown on
 * the button rather than relying on a 429 to tell it to wait.
 */
export async function resendVerificationOtp(email: string): Promise<void> {
  const pending = await repo.findLatestPendingSignup(email);
  if (!pending) return;

  await issueSignupOtp(
    {
      email: pending.email,
      firstName: pending.firstName,
      lastName: pending.lastName,
      // Reused, never re-derived: the plaintext password was never stored and
      // the caller does not send it again.
      passwordHash: pending.passwordHash,
    },
    "verification-resend",
    () => {} // rate-limited: send nothing, say the same thing
  );
}

// --- Step 20: forgot password ---------------------------------------------

/**
 * Sends a reset code - or quietly does nothing - and says the same thing either
 * way (PRD BR-AUTH-10 / AC-A16). Every `return` below produces a byte-identical
 * response, so this endpoint cannot be used to discover who has an account.
 *
 * Timing is kept comparable by never awaiting the email send: the slow path and
 * the do-nothing paths finish in about the same time.
 */
export async function sendPasswordResetOtp(email: string): Promise<void> {
  const user = await repo.findUserByEmail(email);
  if (!user) return;

  // BR-AUTH-9: a reset email may only be sent to a verified address, otherwise
  // whoever mistyped their email at signup could take over someone else's account.
  if (!user.emailVerifiedAt) return;

  // BR-AUTH-13: 3 per hour. Also stops an attacker minting fresh codes to reset
  // the 5-guess counter on the previous one.
  const recent = await repo.countResetOtpsSince(user.id, new Date(Date.now() - HOUR_MS));
  if (recent >= 3) return;

  const otp = generateNumericOtp();
  await repo.issueResetOtp(user.id, hashToken(otp), fromNow(OTP_TTL_MS));
  sendEmailInBackground(mailer.send(passwordResetEmail(user.email, otp)), "password-reset");
}

// --- Step 21: reset password ----------------------------------------------

export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const user = await repo.findUserByEmail(input.email);
  // Same error as a wrong code: "no such account" must not be discoverable here
  // either.
  if (!user) throw new AppError(400, ErrorCodes.OTP_INVALID, "That code is not valid.");

  const otp = await repo.findLatestUnconsumedOtp(user.id);
  if (!otp) throw new AppError(400, ErrorCodes.OTP_INVALID, "That code is not valid.");

  if (otp.attemptCount >= MAX_OTP_ATTEMPTS) {
    await repo.consumeOtp(otp.id);
    throw new AppError(400, ErrorCodes.OTP_ATTEMPTS_EXCEEDED, "Too many wrong codes. Request a new one.");
  }

  if (otp.expiresAt <= new Date()) {
    throw new AppError(400, ErrorCodes.OTP_EXPIRED, "That code has expired. Request a new one.");
  }

  if (hashToken(input.otp) !== otp.otpHash) {
    // Counting the wrong guesses IS the brute-force defence. Six digits is only
    // a million combinations; without this counter a script cracks it in minutes.
    await repo.incrementOtpAttempts(otp.id);
    throw new AppError(400, ErrorCodes.OTP_INVALID, "That code is not valid.");
  }

  const passwordHash = await hashPassword(input.password);

  await prisma.$transaction(async (tx) => {
    await repo.updateUser(
      user.id,
      // Clearing the lock here is also how a locked-out user recovers (AC-A9).
      { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
      tx
    );
    await repo.consumeOtp(otp.id, tx);
    // BR-AUTH-12: every session on every device dies. If someone else knew the
    // old password, this is what actually removes them.
    await repo.revokeAllUserSessions(user.id, tx);
  });

  // Deliberately no tokens in the response: we just revoked everything, so
  // signing the user straight back in would contradict that. They go to Login.
}
