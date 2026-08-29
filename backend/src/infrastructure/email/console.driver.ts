import { Mailer } from "./mailer";

/**
 * Development driver: prints the email to your terminal instead of sending it.
 * No provider account, no API key, no waiting for delivery — copy the link or
 * code straight out of the console while testing.
 *
 * console.log on purpose, not the pino logger: the logger redacts anything that
 * looks like a token, which is exactly what you need to read here.
 */
export const consoleDriver: Mailer = {
  async send(msg) {
    console.log(
      [
        "",
        "==================== EMAIL (console driver) ====================",
        `To:      ${msg.to}`,
        `Subject: ${msg.subject}`,
        "----------------------------------------------------------------",
        msg.text,
        "================================================================",
        "",
      ].join("\n")
    );
  },
};
