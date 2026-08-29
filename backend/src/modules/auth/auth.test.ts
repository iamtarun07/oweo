import request from "supertest";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";

/**
 * End-to-end tests for the nine auth endpoints, one per item in the guide's
 * Part 5 checklist.
 *
 * They talk to the REAL database, so Docker must be running:
 *   docker compose up -d
 *   npm test
 *
 * supertest calls the app in-process - no port is opened. That only works
 * because app.ts exports the app without calling listen().
 */

// Replace the mail driver with an array we can read. The templates stay real,
// so a broken email template still fails a test.
//
// vi.hoisted is needed because vitest moves vi.mock() above the imports, and
// the factory below would otherwise run before this array exists.
const { sentEmails } = vi.hoisted(() => ({
  sentEmails: [] as { to: string; subject: string; text: string }[],
}));

vi.mock("../../infrastructure/email/mailer", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../infrastructure/email/mailer")>();
  return {
    ...original,
    mailer: {
      send: async (msg: { to: string; subject: string; text: string }) => {
        sentEmails.push(msg);
      },
    },
  };
});

import app from "../../app";
import { prisma } from "../../infrastructure/database/prisma";
import * as mail from "../../infrastructure/email/mailer";

const BASE = "/api/v1/auth";
const PASSWORD = "correct-horse-battery";

const newUser = (email = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`) => ({
  firstName: "Tarun",
  lastName: "Kumar",
  email,
  password: PASSWORD,
});

/** Emails are sent in the background, so give them a moment to land. */
async function waitForEmail(count: number) {
  for (let i = 0; i < 100 && sentEmails.length < count; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const last = sentEmails.at(-1);
  if (!last) throw new Error("no email was sent");
  return last;
}

async function register(body = newUser()) {
  const res = await request(app).post(`${BASE}/register`).send(body);
  expect(res.status).toBe(201);
  return { res, body, tokens: res.body.data as { accessToken: string; refreshToken: string } };
}

/** Marks a user verified directly - faster than going through the email flow. */
function markVerified(email: string) {
  return prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
}

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  // Sessions, tokens and OTPs are removed by the cascade on User.
  await prisma.user.deleteMany();
  sentEmails.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// --- Registration (AC-A1, A2, A3, A5, EC-A1) --------------------------------

describe("POST /register", () => {
  it("creates an unverified account with tokens and a friend code - AC-A1", async () => {
    const { res, body } = await register();

    expect(res.body.data.user).toMatchObject({ email: body.email, emailVerified: false });
    expect(res.body.data.user.friendCode).toHaveLength(7);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();

    // Nothing secret may ever appear in a response.
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
    expect(JSON.stringify(res.body)).not.toContain("failedLoginAttempts");

    const user = await prisma.user.findUniqueOrThrow({ where: { email: body.email } });
    expect(user.passwordHash).not.toContain(PASSWORD);
    expect(user.emailVerifiedAt).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.emailVerificationToken.count({ where: { userId: user.id } })).toBe(1);
  });

  it("rejects a duplicate email in ANY letter case - AC-A2", async () => {
    const { body } = await register();

    const same = await request(app).post(`${BASE}/register`).send(body);
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe("EMAIL_ALREADY_EXISTS");

    const upper = await request(app)
      .post(`${BASE}/register`)
      .send({ ...body, email: body.email.toUpperCase() });
    expect(upper.status).toBe(409);
  });

  it("reports every bad field in one response - VR-U-8", async () => {
    const res = await request(app)
      .post(`${BASE}/register`)
      .send({ firstName: "T4run", lastName: "Kumar", email: "not-an-email", password: "short" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(Object.keys(res.body.error.details).sort()).toEqual(["email", "firstName", "password"]);
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("rejects a password from the common-password list - EC-A11 / §26.1", async () => {
    const res = await request(app)
      .post(`${BASE}/register`)
      .send({ ...newUser(), password: "password1" });

    expect(res.status).toBe(400);
    expect(res.body.error.details.password).toMatch(/too common/i);
  });

  it("succeeds even when sending the email fails - AC-A3", async () => {
    const broken = vi.spyOn(mail.mailer, "send").mockRejectedValueOnce(new Error("mail provider is down"));

    const res = await request(app).post(`${BASE}/register`).send(newUser());
    expect(res.status).toBe(201);

    broken.mockRestore();
  });

  it("creates exactly one account when two identical registrations race - EC-A1", async () => {
    const body = newUser();
    const results = await Promise.all([
      request(app).post(`${BASE}/register`).send(body),
      request(app).post(`${BASE}/register`).send(body),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.user.count({ where: { email: body.email } })).toBe(1);
  });
});

// --- Login (AC-A6...A9, EC-A8, EC-A11) --------------------------------------

describe("POST /login", () => {
  it("returns tokens for correct credentials - AC-A6", async () => {
    const { body } = await register();

    const res = await request(app).post(`${BASE}/login`).send({ email: body.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).toBeTruthy();
  });

  it("answers identically for a wrong password and an unknown email - AC-A7", async () => {
    const { body } = await register();

    const wrong = await request(app).post(`${BASE}/login`).send({ email: body.email, password: "wrong-password-x" });
    const unknown = await request(app)
      .post(`${BASE}/login`)
      .send({ email: "nobody@example.com", password: "wrong-password-x" });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    // Byte-identical apart from the per-request id.
    expect({ ...wrong.body.error, requestId: null }).toEqual({ ...unknown.body.error, requestId: null });
  });

  it("locks the account after 5 failures and reports it on the next attempt - AC-A8", async () => {
    const { body } = await register();

    for (let i = 0; i < 5; i++) {
      const res = await request(app).post(`${BASE}/login`).send({ email: body.email, password: "wrong-password-x" });
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    }

    // The 6th attempt uses the CORRECT password and must still be refused.
    const locked = await request(app).post(`${BASE}/login`).send({ email: body.email, password: PASSWORD });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
    expect(locked.body.error.message).toMatch(/\d+ minute/);
  });

  it("does not trim the password - EC-A11", async () => {
    const body = { ...newUser(), password: `${PASSWORD} ` };
    await request(app).post(`${BASE}/register`).send(body).expect(201);

    await request(app).post(`${BASE}/login`).send({ email: body.email, password: PASSWORD }).expect(401);
    await request(app).post(`${BASE}/login`).send({ email: body.email, password: `${PASSWORD} ` }).expect(200);
  });

  it("keeps both sessions alive when the same user logs in twice - EC-A8", async () => {
    const { body, tokens } = await register();

    const second = await request(app).post(`${BASE}/login`).send({ email: body.email, password: PASSWORD });

    await request(app).post(`${BASE}/refresh`).send({ refreshToken: tokens.refreshToken }).expect(200);
    await request(app).post(`${BASE}/refresh`).send({ refreshToken: second.body.data.refreshToken }).expect(200);
  });
});

// --- /me and requireAuth (AC-A21, AR-12) ------------------------------------

describe("GET /me", () => {
  it("returns the public user for a valid access token", async () => {
    const { body, tokens } = await register();

    const res = await request(app).get(`${BASE}/me`).set("Authorization", `Bearer ${tokens.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(body.email);
  });

  it("rejects a missing or broken token", async () => {
    await request(app).get(`${BASE}/me`).expect(401);

    const bad = await request(app).get(`${BASE}/me`).set("Authorization", "Bearer not.a.token");
    expect(bad.body.error.code).toBe("TOKEN_INVALID");
  });

  it("lets an UNVERIFIED user through - AR-12", async () => {
    const { tokens } = await register();
    const res = await request(app).get(`${BASE}/me`).set("Authorization", `Bearer ${tokens.accessToken}`);
    expect(res.body.data.user.emailVerified).toBe(false);
  });
});

// --- Refresh rotation (AC-A22) ---------------------------------------------

describe("POST /refresh", () => {
  it("rotates: the new token works and the old one stops working", async () => {
    const { tokens } = await register();

    const first = await request(app).post(`${BASE}/refresh`).send({ refreshToken: tokens.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.data.refreshToken).not.toBe(tokens.refreshToken);

    await request(app).post(`${BASE}/refresh`).send({ refreshToken: tokens.refreshToken }).expect(401);
  });

  it("replaying a rotated token kills the whole family - AC-A22", async () => {
    const { tokens } = await register();

    const rotated = await request(app).post(`${BASE}/refresh`).send({ refreshToken: tokens.refreshToken });
    const goodToken = rotated.body.data.refreshToken;

    // The attacker replays the old token...
    await request(app).post(`${BASE}/refresh`).send({ refreshToken: tokens.refreshToken }).expect(401);

    // ...and the legitimate token dies too. That is the intended outcome: the
    // real user is signed out, which is how they find out about the theft.
    await request(app).post(`${BASE}/refresh`).send({ refreshToken: goodToken }).expect(401);
  });

  it("returns the same generic error for an unknown token", async () => {
    const res = await request(app).post(`${BASE}/refresh`).send({ refreshToken: "made-up-token" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("TOKEN_INVALID");
  });
});

// --- Logout (AC-C12, EC-C7) -------------------------------------------------

describe("POST /logout", () => {
  it("revokes only this device's family - AC-C12", async () => {
    const { body, tokens } = await register();
    const otherDevice = await request(app).post(`${BASE}/login`).send({ email: body.email, password: PASSWORD });

    await request(app)
      .post(`${BASE}/logout`)
      .set("Authorization", `Bearer ${tokens.accessToken}`)
      .send({ refreshToken: tokens.refreshToken })
      .expect(204);

    await request(app).post(`${BASE}/refresh`).send({ refreshToken: tokens.refreshToken }).expect(401);
    await request(app)
      .post(`${BASE}/refresh`)
      .send({ refreshToken: otherDevice.body.data.refreshToken })
      .expect(200);
  });

  it("is idempotent - logging out twice is still a success", async () => {
    const { tokens } = await register();
    const logout = () =>
      request(app)
        .post(`${BASE}/logout`)
        .set("Authorization", `Bearer ${tokens.accessToken}`)
        .send({ refreshToken: tokens.refreshToken });

    await logout().expect(204);
    await logout().expect(204);
  });
});

// --- Email verification (AC-A10...A13, EC-A14) ------------------------------

/** Pulls the token out of the verification link in the emailed text. */
function tokenFromEmail(text: string) {
  const match = /token=([\w-]+)/.exec(text);
  if (!match?.[1]) throw new Error(`no token in email: ${text}`);
  return match[1];
}

describe("POST /verify-email", () => {
  it("verifies once, and a second use is still a success - AC-A10, AC-A12", async () => {
    const { body } = await register();
    const token = tokenFromEmail((await waitForEmail(1)).text);

    await request(app).post(`${BASE}/verify-email`).send({ token }).expect(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: body.email } });
    expect(user.emailVerifiedAt).not.toBeNull();

    // Same link clicked again (people do this) - the goal is met, so no error.
    await request(app).post(`${BASE}/verify-email`).send({ token }).expect(200);
  });

  it("refuses an expired token - AC-A11", async () => {
    await register();
    const token = tokenFromEmail((await waitForEmail(1)).text);

    await prisma.emailVerificationToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).post(`${BASE}/verify-email`).send({ token });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("TOKEN_EXPIRED");
  });

  it("issuing a new token kills the previous one - EC-A14", async () => {
    const { tokens } = await register();
    const oldToken = tokenFromEmail((await waitForEmail(1)).text);

    // Backdate the first request so the 1-per-minute limit does not block us.
    await prisma.emailVerificationToken.updateMany({
      data: { createdAt: new Date(Date.now() - 5 * 60 * 1000) },
    });

    await request(app)
      .post(`${BASE}/verify-email/resend`)
      .set("Authorization", `Bearer ${tokens.accessToken}`)
      .expect(200);

    const newToken = tokenFromEmail((await waitForEmail(2)).text);
    expect(newToken).not.toBe(oldToken);

    await request(app).post(`${BASE}/verify-email`).send({ token: oldToken }).expect(401);
    await request(app).post(`${BASE}/verify-email`).send({ token: newToken }).expect(200);
  });

  it("rate-limits resend to 1 per minute - AC-A13", async () => {
    const { tokens } = await register();
    await waitForEmail(1);

    const res = await request(app)
      .post(`${BASE}/verify-email/resend`)
      .set("Authorization", `Bearer ${tokens.accessToken}`);

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(sentEmails).toHaveLength(1); // no second email went out
  });
});

// --- Password reset (AC-A15...A19, AC-A9) -----------------------------------

/** Pulls the 6-digit code out of the reset email. */
function otpFromEmail(text: string) {
  const match = /\b(\d{6})\b/.exec(text);
  if (!match?.[1]) throw new Error(`no OTP in email: ${text}`);
  return match[1];
}

async function verifiedUserWithOtp() {
  const { body } = await register();
  await markVerified(body.email);
  await waitForEmail(1);

  await request(app).post(`${BASE}/forgot-password`).send({ email: body.email }).expect(200);
  const otp = otpFromEmail((await waitForEmail(2)).text);
  return { email: body.email, otp };
}

describe("POST /forgot-password", () => {
  it("says the same thing for verified, unverified and unknown emails - AC-A15, A16, BR-AUTH-10", async () => {
    const { body: verified } = await register();
    await markVerified(verified.email);
    const { body: unverified } = await register();
    await waitForEmail(2);
    sentEmails.length = 0;

    const a = await request(app).post(`${BASE}/forgot-password`).send({ email: verified.email });
    const b = await request(app).post(`${BASE}/forgot-password`).send({ email: unverified.email });
    const c = await request(app).post(`${BASE}/forgot-password`).send({ email: "nobody@example.com" });

    for (const res of [a, b, c]) expect(res.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(b.body).toEqual(c.body);

    // Only the verified account actually got a code.
    await waitForEmail(1);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.to).toBe(verified.email);
  });

  it("stops sending after 3 requests in an hour, same message - AC-A19", async () => {
    const { body } = await register();
    await markVerified(body.email);
    await waitForEmail(1);
    sentEmails.length = 0;

    for (let i = 0; i < 4; i++) {
      const res = await request(app).post(`${BASE}/forgot-password`).send({ email: body.email });
      expect(res.status).toBe(200);
    }

    await waitForEmail(3);
    await new Promise((r) => setTimeout(r, 100)); // give a 4th email a chance to appear
    expect(sentEmails).toHaveLength(3);
  });
});

describe("POST /reset-password", () => {
  it("changes the password and revokes every session - AC-A17, BR-AUTH-12", async () => {
    const { email, otp } = await verifiedUserWithOtp();
    const session = await request(app).post(`${BASE}/login`).send({ email, password: PASSWORD });
    const oldRefresh = session.body.data.refreshToken;

    const res = await request(app)
      .post(`${BASE}/reset-password`)
      .send({ email, otp, password: "brand-new-passphrase" });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeUndefined(); // no auto sign-in

    await request(app).post(`${BASE}/refresh`).send({ refreshToken: oldRefresh }).expect(401);
    await request(app).post(`${BASE}/login`).send({ email, password: PASSWORD }).expect(401);
    await request(app).post(`${BASE}/login`).send({ email, password: "brand-new-passphrase" }).expect(200);
  });

  it("refuses a reused code - AC-A18", async () => {
    const { email, otp } = await verifiedUserWithOtp();
    await request(app).post(`${BASE}/reset-password`).send({ email, otp, password: "brand-new-passphrase" }).expect(200);

    const again = await request(app)
      .post(`${BASE}/reset-password`)
      .send({ email, otp, password: "another-new-passphrase" });

    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("OTP_INVALID");
  });

  it("kills the code after 5 wrong guesses", async () => {
    const { email, otp } = await verifiedUserWithOtp();

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(`${BASE}/reset-password`)
        .send({ email, otp: "000000", password: "brand-new-passphrase" });
      expect(res.body.error.code).toBe("OTP_INVALID");
    }

    // The 6th attempt uses the CORRECT code and must still be refused.
    const res = await request(app).post(`${BASE}/reset-password`).send({ email, otp, password: "brand-new-passphrase" });
    expect(res.body.error.code).toBe("OTP_ATTEMPTS_EXCEEDED");
  });

  it("hides an unknown email behind the same generic error", async () => {
    const res = await request(app)
      .post(`${BASE}/reset-password`)
      .send({ email: "nobody@example.com", otp: "123456", password: "brand-new-passphrase" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("OTP_INVALID");
  });

  it("unlocks a locked account - AC-A9", async () => {
    const { email, otp } = await verifiedUserWithOtp();

    for (let i = 0; i < 5; i++) {
      await request(app).post(`${BASE}/login`).send({ email, password: "wrong-password-x" });
    }
    await request(app).post(`${BASE}/login`).send({ email, password: PASSWORD }).expect(423);

    await request(app).post(`${BASE}/reset-password`).send({ email, otp, password: "brand-new-passphrase" }).expect(200);

    // Reset clears the lock, so the user can sign in straight away.
    await request(app).post(`${BASE}/login`).send({ email, password: "brand-new-passphrase" }).expect(200);
  });
});
