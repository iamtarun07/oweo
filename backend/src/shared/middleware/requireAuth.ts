import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import { env } from "../../infrastructure/config/env";
import { prisma } from "../../infrastructure/database/prisma";
import { AppError } from "../errors/AppError";

/**
 * Guards every protected route: proves who is calling and loads their row.
 *
 * Deliberately does NOT check email verification. PRD BR-AUTH-1 / AR-12: an
 * unverified user may use the whole app; verification only gates password
 * reset. Checking it here would lock new users out of everything.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    return next(AppError.unauthenticated());
  }

  const token = header.slice("Bearer ".length);

  let payload: jwt.JwtPayload;
  try {
    // verify() checks the signature AND the expiry, and throws on either.
    payload = jwt.verify(token, env.ACCESS_TOKEN_SECRET) as jwt.JwtPayload;
  } catch (err) {
    // Expired gets its own code on purpose: the Flutter app should quietly
    // call /refresh, whereas TOKEN_INVALID means "sign in again".
    if (err instanceof jwt.TokenExpiredError) {
      return next(AppError.tokenExpired("Your session expired. Refreshing..."));
    }
    return next(AppError.tokenInvalid("Your session is not valid. Please sign in again."));
  }

  // The user could have been deleted since the token was issued, so a valid
  // signature is not proof the account still exists.
  const user = typeof payload.sub === "string" ? await prisma.user.findUnique({ where: { id: payload.sub } }) : null;
  if (!user) return next(AppError.unauthenticated());

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return next(AppError.unauthenticated("This account is temporarily locked."));
  }

  req.user = user;
  next();
}

/**
 * Narrows `req.user` from "User | undefined" to "User" for handlers that run
 * behind requireAuth. Without this, TypeScript still sees it as possibly
 * undefined and every controller needs its own check.
 */
export function currentUser(req: Request) {
  if (!req.user) throw AppError.unauthenticated();
  return req.user;
}
