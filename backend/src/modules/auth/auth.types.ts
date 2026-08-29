import type { User } from "../../generated/prisma/client";

/** Exactly what the API is allowed to say about a user. */
export interface PublicUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  emailVerified: boolean;
  friendCode: string;
}

export interface AuthPayload {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

/**
 * The single mapper between a database row and a response.
 *
 * Every endpoint goes through this function, which is what guarantees
 * passwordHash, failedLoginAttempts and lockedUntil can never leak: there is
 * no other path from a User row to JSON.
 */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    friendCode: user.friendCode,
  };
}

/**
 * Account state is DERIVED, never stored (PRD §11.1).
 * A stored enum would say LOCKED_TEMPORARY forever, because nothing runs at
 * the moment lockedUntil passes to change it. Two timestamps cannot go stale.
 */
export type AccountState = "ACTIVE_UNVERIFIED" | "ACTIVE_VERIFIED" | "LOCKED_TEMPORARY";

export function accountState(user: User, now: Date): AccountState {
  if (user.lockedUntil && user.lockedUntil > now) return "LOCKED_TEMPORARY";
  if (user.emailVerifiedAt === null) return "ACTIVE_UNVERIFIED";
  return "ACTIVE_VERIFIED";
}
