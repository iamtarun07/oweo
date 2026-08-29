import { env } from "../config/env";
import { Mailer } from "./mailer";
import { logger } from "../../shared/logger";

/**
 * Real sending through Resend (free tier: ~100 emails/day, no card needed).
 * Turn it on with MAIL_DRIVER=resend and RESEND_API_KEY=... in .env.
 *
 * Plain `fetch` (built into Node 18+) instead of Resend's SDK: the whole API
 * call is six lines, so a dependency would earn nothing.
 *
 * Note: until you verify your own domain, Resend only delivers to the address
 * you signed up with, and MAIL_FROM must be onboarding@resend.dev.
 */
export const resendDriver: Mailer = {
  async send(msg) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
      }),
    });

    if (!res.ok) {
      // Log the provider's reason (it never contains the token, only the
      // recipient and the failure) and throw so the caller can decide.
      logger.error({ status: res.status, body: await res.text() }, "resend send failed");
      throw new Error(`Resend responded ${res.status}`);
    }

    // Resend returns the message id. Logging it means a "did my email send?"
    // question is answerable: paste the id into the Resend dashboard and see
    // delivered / bounced / complained.
    const { id } = (await res.json()) as { id?: string };
    logger.info({ resendId: id, subject: msg.subject }, "email sent");
  },
};
