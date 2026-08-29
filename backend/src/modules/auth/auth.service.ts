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
import type { LoginInput, RegisterInput, ResetPasswordInput } from "./auth.schemas";
import { AuthPayload, toPublicUser } from "./auth.types";

// ponytail: per-account lockout only. Per-origin limiting (PRD 29.5, SEC-29)
// needs Redis - Phase 9. Do not build an IP table in Postgres for this.

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * MINUTE_MS;
const VERIFICATION_TTL_MS = 24 * HOUR_MS; // BR-AUTH-5
const OTP_TTL_MS = 10 * MINUTE_MS;
const MAX_OTP_ATTEMPTS = 5;

/** Same wording for every branch of /forgot-password. See sendPasswordResetOtp. */
export const NEUTRAL_RESET_MESSAGE = "If an account exists for this email, we've sent a code.";

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

export async function register(input: RegisterInput, userAgent?: string): Promise<AuthPayload> {
  // Hashing FIRST, before we know whether the email is taken. If we returned
  // early on a duplicate, that path would answer in ~5ms while a new account
  // takes ~200ms, and the difference alone tells an attacker which emails are
  // registered (PRD SEC-4).
  const passwordHash = await hashPassword(input.password);

  const verificationToken = generateOpaqueToken();

  let user: User;
  try {
    // One transaction: either the user AND their verification token exist, or
    // neither does. No half-created accounts.
    user = await prisma.$transaction(async (tx) => {
      const created = await repo.createUser(
        { email: input.email, passwordHash, firstName: input.firstName, lastName: input.lastName },
        tx
      );
      await repo.issueVerificationToken(
        created.id,
        hashToken(verificationToken),
        fromNow(VERIFICATION_TTL_MS),
        tx
      );
      return created;
    });
  } catch (err) {
    // We never SELECT to check the email first - two simultaneous signups would
    // both pass that check (PRD EC-A1). The unique index is the only atomic
    // judge, so we insert and translate its complaint.
    if (repo.isUniqueViolation(err, "email")) {
      throw AppError.conflict(ErrorCodes.EMAIL_ALREADY_EXISTS, "An account with this email already exists.");
    }
    throw err;
  }

  const refreshToken = await startSession(user.id, userAgent);

  // Outside the transaction on purpose: mail inside it would hold a database
  // connection open for the provider's round trip, and a mail failure would
  // roll back a perfectly good account.
  sendEmailInBackground(mailer.send(verificationEmail(user.email, verificationToken)), "verification");

  return authPayload(user, refreshToken);
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

export async function verifyEmail(token: string): Promise<void> {
  const row = await repo.findVerificationToken(hashToken(token));
  if (!row) throw AppError.tokenInvalid("This verification link is not valid.");

  if (row.consumedAt) {
    const user = await repo.findUserById(row.userId);
    // Already used AND already verified: the user's goal is achieved, so
    // showing an error would be confusing and pointless (PRD AC-A12).
    if (user?.emailVerifiedAt) return;
    throw AppError.tokenInvalid("This verification link has already been used.");
  }

  if (row.expiresAt <= new Date()) {
    throw AppError.tokenExpired("This link has expired. Request a new one.");
  }

  await prisma.$transaction(async (tx) => {
    await repo.consumeVerificationToken(row.id, tx);
    await repo.updateUser(row.userId, { emailVerifiedAt: new Date() }, tx);
  });
}

// --- Step 19: resend verification -----------------------------------------

export async function resendVerification(user: User): Promise<void> {
  if (user.emailVerifiedAt) return; // nothing to do; not an error

  const now = new Date();

  // BR-AUTH-6: at most 1 per minute and 5 per day. The token rows already carry
  // createdAt, so counting them is the whole rate limiter - no Redis needed.
  const lastMinute = await repo.countVerificationTokensSince(user.id, new Date(now.getTime() - MINUTE_MS));
  if (lastMinute > 0) throw AppError.rateLimited("Please wait a minute before requesting another email.");

  const lastDay = await repo.countVerificationTokensSince(user.id, new Date(now.getTime() - DAY_MS));
  if (lastDay >= 5) throw AppError.rateLimited("Too many requests today. Please try again tomorrow.");

  const token = generateOpaqueToken();
  await repo.issueVerificationToken(user.id, hashToken(token), fromNow(VERIFICATION_TTL_MS, now));
  sendEmailInBackground(mailer.send(verificationEmail(user.email, token)), "verification-resend");
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
