import { Router } from "express";

import { requireAuth } from "../../shared/middleware/requireAuth";
import { validate } from "../../shared/middleware/validate";
import * as controller from "./auth.controller";
import {
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "./auth.schemas";

/**
 * The nine auth endpoints. Mounted at /api/v1/auth in app.ts, so no path here
 * repeats that prefix.
 *
 * Read each line left to right: it is the exact order the request passes
 * through - validate the body, prove who you are, then run the handler.
 */
const router = Router();

router.post("/register", validate(registerSchema), controller.register);
router.post("/login", validate(loginSchema), controller.login);

router.get("/me", requireAuth, controller.me);

// No requireAuth: the whole point of refreshing is that the access token has
// already expired.
router.post("/refresh", validate(refreshSchema), controller.refresh);

router.post("/logout", requireAuth, validate(logoutSchema), controller.logout);

// Neither of these can require a Bearer token: the caller has no account yet.
// /verify-email is what creates it, and it is the endpoint that returns tokens.
router.post("/verify-email", validate(verifyEmailSchema), controller.verifyEmail);
router.post("/verify-email/resend", validate(resendVerificationSchema), controller.resendVerification);

router.post("/forgot-password", validate(forgotPasswordSchema), controller.forgotPassword);
router.post("/reset-password", validate(resetPasswordSchema), controller.resetPassword);

export default router;
