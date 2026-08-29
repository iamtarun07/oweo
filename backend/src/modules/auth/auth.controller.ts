import { Request, Response } from "express";

import { currentUser } from "../../shared/middleware/requireAuth";
import * as service from "./auth.service";
import { NEUTRAL_RESET_MESSAGE } from "./auth.service";
import { toPublicUser } from "./auth.types";

/**
 * Controllers do three things only: read the request, call the service, shape
 * the response. No business rules here - keeping them out is what lets the
 * service be reused later (Phase 5) and tested without HTTP.
 *
 * No try/catch either: Express 5 forwards a rejected promise to errorHandler
 * automatically. (Express 4 did not, which is why older guides wrap everything.)
 */

// Every success uses the same envelope, so the Flutter app writes one parser.
const ok = (res: Response, status: number, data: unknown) => res.status(status).json({ data });

export async function register(req: Request, res: Response) {
  const payload = await service.register(req.body, req.get("user-agent"));
  ok(res, 201, payload);
}

export async function login(req: Request, res: Response) {
  const payload = await service.login(req.body, req.get("user-agent"));
  ok(res, 200, payload);
}

export async function me(req: Request, res: Response) {
  ok(res, 200, { user: toPublicUser(currentUser(req)) });
}

export async function refresh(req: Request, res: Response) {
  const payload = await service.refresh(req.body.refreshToken, req.get("user-agent"));
  ok(res, 200, payload);
}

export async function logout(req: Request, res: Response) {
  await service.logout(currentUser(req).id, req.body.refreshToken);
  res.status(204).send(); // 204 = success, nothing to say
}

export async function verifyEmail(req: Request, res: Response) {
  await service.verifyEmail(req.body.token);
  ok(res, 200, { message: "Your email is verified." });
}

export async function resendVerification(req: Request, res: Response) {
  await service.resendVerification(currentUser(req));
  ok(res, 200, { message: "If your email needs verifying, we've sent a new link." });
}

export async function forgotPassword(req: Request, res: Response) {
  await service.sendPasswordResetOtp(req.body.email);
  // Identical response whether or not an account exists - see the service.
  ok(res, 200, { message: NEUTRAL_RESET_MESSAGE });
}

export async function resetPassword(req: Request, res: Response) {
  await service.resetPassword(req.body);
  // No tokens on purpose: every session was just revoked, so the user signs in
  // again with the new password.
  ok(res, 200, { message: "Password changed. You have been signed out on all devices." });
}
