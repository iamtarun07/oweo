/**
 * Throwaway script: sends both real emails through the configured driver.
 *
 *   npx tsx mail-check.ts                     -> Resend sandbox address
 *   npx tsx mail-check.ts you@yourmail.com    -> your own inbox
 *
 * Delete this file whenever you like; nothing imports it.
 */
import { mailer, passwordResetEmail, verificationEmail } from "./src/infrastructure/email/mailer";

const to = process.argv[2] ?? "delivered@resend.dev";

(async () => {
  await mailer.send(verificationEmail(to, "483920"));
  await mailer.send(passwordResetEmail(to, "042317"));
  console.log(`sent both emails to ${to}`);
})();
