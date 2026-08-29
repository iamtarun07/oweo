import 'dotenv/config';
import { z } from 'zod';

/**
 * The ONLY place in the codebase that reads process.env.
 * Parsed once at import time; a bad environment crashes the process here,
 * at boot, instead of surfacing as a confusing runtime error later.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().int().positive(),
    DATABASE_URL: z.string().min(1).startsWith('postgresql://'),

    ACCESS_TOKEN_SECRET: z.string().min(32),
    REFRESH_TOKEN_SECRET: z.string().min(32),
    ACCESS_TOKEN_TTL: z.string().regex(/^\d+[smhd]$/, 'must look like 15m, 1h, 7d'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive(),

    APP_BASE_URL: z.string().url(),
    CORS_ORIGINS: z
  .string()
  .min(1)
  .transform((value) =>
    value.split(',').map((origin) => origin.trim())
  ),
    MAIL_DRIVER: z.enum(['console', 'resend']),
    MAIL_FROM: z.string().min(1),

    // Only needed when MAIL_DRIVER=resend. Resend's free tier is enough for
    // development; with the console driver this stays empty.
    RESEND_API_KEY: z.string().optional(),

    // Optional with a sensible default, so .env can stay short.
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('debug'),
  })
  .refine((e) => e.ACCESS_TOKEN_SECRET !== e.REFRESH_TOKEN_SECRET, {
    message: 'ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be different values',
    path: ['REFRESH_TOKEN_SECRET'],
  })
  // Catch the mistake at boot instead of at the first password-reset email.
  .refine((e) => e.MAIL_DRIVER !== 'resend' || !!e.RESEND_API_KEY, {
    message: 'RESEND_API_KEY is required when MAIL_DRIVER=resend',
    path: ['RESEND_API_KEY'],
  });

  

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  console.error(`\nInvalid environment configuration:\n${details}\n\nSee .env.example for the required keys.\n`);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export type Env = typeof env;
