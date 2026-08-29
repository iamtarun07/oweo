import { Prisma } from "../../generated/prisma/client";
import type { EmailVerificationToken, PasswordResetOtp, Session, User } from "../../generated/prisma/client";
import { prisma } from "../../infrastructure/database/prisma";
import { generateFriendCode } from "../../shared/crypto/friendCode";

/**
 * All database access for auth lives here — the service never touches prisma
 * directly. That split is what lets the service be read (and tested) as pure
 * business rules.
 *
 * Every function takes an optional `db`, so the same function works standalone
 * or inside a transaction: `createUser(data, tx)`.
 */
export type Db = Prisma.TransactionClient | typeof prisma;

// --- User ------------------------------------------------------------------

export function findUserByEmail(email: string, db: Db = prisma): Promise<User | null> {
  return db.user.findUnique({ where: { email } });
}

export function findUserById(id: string, db: Db = prisma): Promise<User | null> {
  return db.user.findUnique({ where: { id } });
}

/**
 * Insert a user, generating a friend code and retrying if it collides.
 *
 * We do NOT check "is this code taken?" first: between the check and the insert
 * another request could take it (a race condition). The unique constraint in
 * the database is the only thing that can decide this atomically, so we insert
 * and react to P2002 instead. With 27.5 billion codes this retry realistically
 * never runs — it is correctness insurance, not a hot path.
 */
export async function createUser(
  data: { email: string; passwordHash: string; firstName: string; lastName: string },
  db: Db = prisma
): Promise<User> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.user.create({ data: { ...data, friendCode: generateFriendCode() } });
    } catch (err) {
      if (isUniqueViolation(err, "friendCode")) continue; // collision: new code, try again
      throw err; // anything else (including a duplicate email) is the caller's problem
    }
  }
  throw new Error("Could not generate a unique friend code after 5 attempts");
}

/**
 * True when Prisma rejected an insert because a unique column already held this
 * value (error P2002), optionally checking WHICH column - "email" collided and
 * "friendCode" collided need different reactions.
 *
 * Prisma names the column in two different places depending on the driver, so
 * we look in both: `meta.target` (older/engine path) and the constraint name
 * the Postgres adapter passes through, e.g. "User_email_key".
 */
export function isUniqueViolation(err: unknown, field?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  if (!field) return true;

  const meta = err.meta as
    | { target?: string | string[]; driverAdapterError?: { cause?: { constraint?: { index?: string } } } }
    | undefined;

  const target = meta?.target;
  if (Array.isArray(target) ? target.includes(field) : String(target ?? "").includes(field)) return true;

  return (meta?.driverAdapterError?.cause?.constraint?.index ?? "").includes(field);
}

export function updateUser(id: string, data: Prisma.UserUpdateInput, db: Db = prisma): Promise<User> {
  return db.user.update({ where: { id }, data });
}

// --- Sessions (refresh tokens) --------------------------------------------

export function createSession(
  data: { userId: string; familyId: string; tokenHash: string; expiresAt: Date; userAgent?: string },
  db: Db = prisma
): Promise<Session> {
  return db.session.create({ data });
}

export function findSessionByTokenHash(tokenHash: string, db: Db = prisma): Promise<Session | null> {
  return db.session.findUnique({ where: { tokenHash } });
}

/**
 * Mark the old row rotated — but ONLY if nobody rotated it first.
 * `rotatedAt: null` in the where clause makes this a compare-and-set: two
 * concurrent refreshes with the same token cannot both match, so exactly one
 * wins and the other is (correctly) treated as a replay.
 * Returns how many rows were updated: 0 means we lost the race.
 */
export async function markSessionRotated(
  sessionId: string,
  replacedById: string | null,
  db: Db = prisma
): Promise<number> {
  const result = await db.session.updateMany({
    where: { id: sessionId, rotatedAt: null },
    data: { rotatedAt: new Date(), ...(replacedById ? { replacedById } : {}) },
  });
  return result.count;
}

/** Kill an entire login chain — used on logout and on reuse detection. */
export function revokeFamily(familyId: string, db: Db = prisma) {
  return db.session.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Kill every session on every device — used after a password reset. */
export function revokeAllUserSessions(userId: string, db: Db = prisma) {
  return db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// --- Email verification tokens --------------------------------------------

export function findVerificationToken(
  tokenHash: string,
  db: Db = prisma
): Promise<EmailVerificationToken | null> {
  return db.emailVerificationToken.findUnique({ where: { tokenHash } });
}

/**
 * BR-AUTH-7: issuing a new token must invalidate the older ones.
 * We mark them consumed rather than deleting them, so the verification funnel
 * stays measurable (PRD §32) and there is an audit trail.
 */
export async function issueVerificationToken(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
  db: Db = prisma
): Promise<EmailVerificationToken> {
  await db.emailVerificationToken.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return db.emailVerificationToken.create({ data: { userId, tokenHash, expiresAt } });
}

/** How many verification emails this user asked for since `since` (rate limit). */
export function countVerificationTokensSince(userId: string, since: Date, db: Db = prisma): Promise<number> {
  return db.emailVerificationToken.count({ where: { userId, createdAt: { gte: since } } });
}

export function consumeVerificationToken(id: string, db: Db = prisma) {
  return db.emailVerificationToken.update({ where: { id }, data: { consumedAt: new Date() } });
}

// --- Password reset OTPs ---------------------------------------------------

export async function issueResetOtp(
  userId: string,
  otpHash: string,
  expiresAt: Date,
  db: Db = prisma
): Promise<PasswordResetOtp> {
  await db.passwordResetOtp.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return db.passwordResetOtp.create({ data: { userId, otpHash, expiresAt } });
}

/**
 * The newest unused code FOR THIS USER.
 * Scoping by userId is mandatory: a global "does any row have this hash?"
 * lookup would let one user's code unlock another user's account.
 */
export function findLatestUnconsumedOtp(userId: string, db: Db = prisma): Promise<PasswordResetOtp | null> {
  return db.passwordResetOtp.findFirst({
    where: { userId, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
}

export function countResetOtpsSince(userId: string, since: Date, db: Db = prisma): Promise<number> {
  return db.passwordResetOtp.count({ where: { userId, createdAt: { gte: since } } });
}

export function incrementOtpAttempts(id: string, db: Db = prisma) {
  return db.passwordResetOtp.update({ where: { id }, data: { attemptCount: { increment: 1 } } });
}

export function consumeOtp(id: string, db: Db = prisma) {
  return db.passwordResetOtp.update({ where: { id }, data: { consumedAt: new Date() } });
}
