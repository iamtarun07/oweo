import { z } from "zod";
import { emailSchema, nameSchema, otpSchema, passwordSchema } from "../../shared/validation/primitives";

/**
 * Request shapes for the nine auth endpoints, built from the shared primitives
 * so a rule like "names are 1-40 characters" exists in exactly one file.
 *
 * .strict() rejects unknown keys, which catches typos ("firstname") loudly
 * instead of silently ignoring them.
 */

export const registerSchema = z
  .object({
    firstName: nameSchema,
    lastName: nameSchema,
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    // Login checks the password against a hash; length rules belong to
    // registration only. Rejecting a short password here would tell an attacker
    // their guess was too short — free information.
    password: z.string().min(1, "Enter your password."),
  })
  .strict();

export const refreshSchema = z.object({ refreshToken: z.string().min(1) }).strict();

export const logoutSchema = refreshSchema;

// The email travels with the code because there is no session to infer it from
// - the account does not exist until this request succeeds.
export const verifyEmailSchema = z.object({ email: emailSchema, otp: otpSchema }).strict();

export const resendVerificationSchema = z.object({ email: emailSchema }).strict();

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordSchema = z
  .object({
    email: emailSchema,
    otp: otpSchema,
    password: passwordSchema,
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
