import { env } from "../config/env";
import { consoleDriver } from "./console.driver";
import { resendDriver } from "./resend.driver";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * One tiny interface, two drivers. Services call `mailer.send(...)` and never
 * know which provider is behind it, so swapping providers later is one env
 * change and zero code changes.
 */
export interface Mailer {
  send(msg: EmailMessage): Promise<void>;
}

export const mailer: Mailer = env.MAIL_DRIVER === "resend" ? resendDriver : consoleDriver;

// --- Templates -------------------------------------------------------------
// Two emails, and only two. PRD FR-INV-15 / §5.2 forbid any non-authentication
// email in the MVP, so this is the complete list.
//
// Every message carries BOTH a text and an html version. Mail clients pick one:
// html where they can, text where they cannot (watches, plain-text mode, some
// spam filters). A mail with no text part scores worse with spam filters, so
// the text version is not optional politeness - it is deliverability.

/** Inline CSS only. Email clients strip <style> blocks and know nothing of flexbox. */
function layout(heading: string, bodyHtml: string): string {
  return `
<div style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
    <p style="margin:0 0 24px;font-size:20px;font-weight:700;color:#111827;">Oweo</p>
    <h1 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#111827;">${heading}</h1>
    ${bodyHtml}
    <hr style="margin:28px 0 16px;border:none;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;line-height:18px;color:#6b7280;">
      You received this because someone used this address on Oweo.
      If it was not you, no action is needed.
    </p>
  </div>
</div>`.trim();
}

/**
 * The code shown on the signup flow's second screen.
 *
 * A code, not a link, because the person is already sitting in the app waiting
 * on a six-box input - a link would send them to a browser and strand the
 * screen that is asking the question. It also means the code never leaves the
 * device that started the signup, which a forwarded link cannot promise.
 *
 * Putting the code in the SUBJECT is deliberate: most clients show the subject
 * in the notification, so the code is readable without opening the mail.
 */
export function verificationEmail(to: string, otp: string): EmailMessage {
  return {
    to,
    subject: `${otp} is your Oweo verification code`,
    text: [
      "Welcome to Oweo!",
      "",
      `Your verification code is: ${otp}`,
      "",
      "Enter it on the signup screen to finish creating your account.",
      "",
      "The code expires in 5 minutes, works once, and allows 5 attempts.",
      "If you did not sign up, ignore this email - no account has been created.",
    ].join("\n"),
    html: layout(
      "Confirm your email address",
      `<p style="margin:0 0 20px;font-size:14px;line-height:22px;color:#374151;">
         Enter this code on the signup screen to finish creating your account.
       </p>
       <p style="margin:0 0 20px;padding:16px;background:#f3f4f6;border-radius:8px;text-align:center;
          font-family:Consolas,Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#111827;">
         ${otp}
       </p>
       <p style="margin:0;font-size:13px;line-height:20px;color:#6b7280;">
         Expires in <strong style="color:#374151;">5 minutes</strong> &middot;
         can be used <strong style="color:#374151;">once</strong> &middot;
         <strong style="color:#374151;">5 attempts</strong> allowed
       </p>
       <p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#6b7280;">
         Did not sign up? Ignore this email - no account has been created.
       </p>`
    ),
  };
}

/**
 * The reset code, written for the app's two-screen flow:
 *   screen 1 - enter your email
 *   screen 2 - enter this code, plus the new password, and submit once
 *
 * So the email says "go back to the app", never "click here": there is nothing
 * to click, and a link would only confuse someone already on screen 2.
 * The three limits (5 minutes, one use, five tries) are spelled out because a
 * user who knows them will not sit on a dead code retyping it.
 */
export function passwordResetEmail(to: string, otp: string): EmailMessage {
  return {
    to,
    subject: `${otp} is your Oweo password reset code`,
    text: [
      `Your Oweo password reset code is: ${otp}`,
      "",
      "Enter it on the reset screen together with your new password.",
      "",
      "The code expires in 5 minutes, works once, and allows 5 attempts.",
      "If you did not ask to reset your password, ignore this email - nothing has changed.",
    ].join("\n"),
    html: layout(
      "Your password reset code",
      `<p style="margin:0 0 20px;font-size:14px;line-height:22px;color:#374151;">
         Enter this code on the reset screen, along with your new password.
       </p>
       <p style="margin:0 0 20px;padding:16px;background:#f3f4f6;border-radius:8px;text-align:center;
          font-family:Consolas,Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#111827;">
         ${otp}
       </p>
       <p style="margin:0;font-size:13px;line-height:20px;color:#6b7280;">
         Expires in <strong style="color:#374151;">5 minutes</strong> &middot;
         can be used <strong style="color:#374151;">once</strong> &middot;
         <strong style="color:#374151;">5 attempts</strong> allowed
       </p>
       <p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#6b7280;">
         Did not request this? Ignore this email - your password has not changed.
       </p>`
    ),
  };
}
