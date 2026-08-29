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

/** Pulls the 6-digit code out of an email. Both templates put it in the text. */
function otpFromEmail(text: string) {
  const match = /\b(\d{6})\b/.exec(text);
  if (!match?.[1]) throw new Error(`no OTP in email: ${text}`);
  return match[1];
}

/**
 * Half a signup: the PendingSignup row and the emailed code, no account yet.
 *
 * The email count is captured BEFORE the request. waitForEmail returns the last
 * message in the array, so a test that has already sent one would otherwise read
 * a stale code the moment this is called twice.
 */
async function startSignup(body = newUser()) {
  const target = sentEmails.length + 1;
  const res = await request(app).post(`${BASE}/register`).send(body);
  expect(res.status).toBe(202);
  return { res, body, otp: otpFromEmail((await waitForEmail(target)).text) };
}

/**
 * The whole signup. Tokens come from /verify-email now - registering on its own
 * creates nothing and hands back no credentials - so any test that needs a real
 * account goes through here.
 */
async function signUp(body = newUser()) {
  const { otp } = await startSignup(body);
  const res = await request(app).post(`${BASE}/verify-email`).send({ email: body.email, otp });
  expect(res.status).toBe(201);
  return { res, body, tokens: res.body.data as { accessToken: string; refreshToken: string } };
}

/**
 * Every account is verified the moment it is created, so an unverified one can
 * only be built by hand. Still worth testing: the column stays, and the rules
 * that read it (forgot-password) must keep working.
 */
function markUnverified(email: string) {
  return prisma.user.update({ where: { email }, data: { emailVerifiedAt: null } });
}

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  // Sessions and reset OTPs are removed by the cascade on User. Pending signups
  // are not: they point at no user by design, so they need their own sweep.
  await prisma.user.deleteMany();
  await prisma.pendingSignup.deleteMany();
  sentEmails.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// --- Registration (AC-A1, A2, A3, A5, EC-A1) --------------------------------

describe("POST /register", () => {
  it("creates no account and issues no tokens, only a code - AC-A1", async () => {
    const { res, body, otp } = await startSignup();

    expect(res.status).toBe(202); // accepted, not created
    expect(res.body.data).toMatchObject({ email: body.email });
    expect(res.body.data.accessToken).toBeUndefined();
    expect(res.body.data.refreshToken).toBeUndefined();

    // Nothing secret may ever appear in a response.
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);

    // The account does not exist yet - only the pending row does.
    expect(await prisma.user.count({ where: { email: body.email } })).toBe(0);
    const pending = await prisma.pendingSignup.findFirstOrThrow({ where: { email: body.email } });
    expect(pending.passwordHash).not.toContain(PASSWORD);
    expect(pending.otpHash).not.toContain(otp); // the code itself is never stored
  });

  it("emails a 6-digit code, never a link - AC-A1", async () => {
    const { otp } = await startSignup();

    expect(otp).toMatch(/^\d{6}$/);
    expect(sentEmails[0]?.text).not.toMatch(/https?:\/\//);
  });

  it("rejects a duplicate email in ANY letter case, once verified - AC-A2", async () => {
    const { body } = await signUp();

    const same = await request(app).post(`${BASE}/register`).send(body);
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe("EMAIL_ALREADY_EXISTS");

    const upper = await request(app)
      .post(`${BASE}/register`)
      .send({ ...body, email: body.email.toUpperCase() });
    expect(upper.status).toBe(409);
  });

  it("rate-limits repeat signups for one address to 1 per minute - BR-AUTH-6", async () => {
    const { body } = await startSignup();

    const again = await request(app).post(`${BASE}/register`).send(body);
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe("RATE_LIMITED");
    expect(sentEmails).toHaveLength(1); // no second code went out
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
    expect(res.status).toBe(202);

    broken.mockRestore();
  });

  it("creates exactly one account when the same code is confirmed twice at once - EC-A1", async () => {
    // The collision moved from register to verify: that is where the INSERT is.
    // A double-tapped Submit sends both requests before either has consumed the
    // row, so both reach the insert and only the unique index can separate them.
    const { body, otp } = await startSignup();

    const results = await Promise.all([
      request(app).post(`${BASE}/verify-email`).send({ email: body.email, otp }),
      request(app).post(`${BASE}/verify-email`).send({ email: body.email, otp }),
    ]);

    // Exactly one caller is told the account was created. The loser gets 409 if
    // both inserts raced, or 400 if the row was already consumed by the time it
    // looked - which one depends on interleaving, so only the counts are asserted.
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status >= 400)).toHaveLength(1);
    expect(await prisma.user.count({ where: { email: body.email } })).toBe(1);
  });
});

// --- Login (AC-A6...A9, EC-A8, EC-A11) --------------------------------------

describe("POST /login", () => {
  it("returns tokens for correct credentials - AC-A6", async () => {
    const { body } = await signUp();

    const res = await request(app).post(`${BASE}/login`).send({ email: body.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).toBeTruthy();
  });

  it("answers identically for a wrong password and an unknown email - AC-A7", async () => {
    const { body } = await signUp();

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
    const { body } = await signUp();

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
    // The trailing space has to survive register AND the PendingSignup round
    // trip, so this goes through the whole signup rather than just step one.
    const body = { ...newUser(), password: `${PASSWORD} ` };
    await signUp(body);

    await request(app).post(`${BASE}/login`).send({ email: body.email, password: PASSWORD }).expect(401);
    await request(app).post(`${BASE}/login`).send({ email: body.email, password: `${PASSWORD} ` }).expect(200);
  });

  it("keeps both sessions alive when the same user logs in twice - EC-A8", async () => {
    const { body, tokens } = await signUp();

    const second = await request(app).post(`${BASE}/login`).send({ email: body.email, password: PASSWORD });

    await request(app).post(`${BASE}/refresh`).send({ refreshToken: tokens.refreshToken }).expect(200);
    await request(app).post(`${BASE}/refresh`).send({ refreshToken: second.body.data.refreshToken }).expect(200);
  });
});

// --- /me and requireAuth (AC-A21, AR-12) ------------------------------------

describe("GET /me", () => {
  it("returns the public user for a valid access token", async () => {
    const { body, tokens } = await signUp();

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
    // Signup cannot produce one any more, so the state is forced by hand. The
    // rule still matters: requireAuth must gate on "is this a real session",
    // never on emailVerified, or a future email change would lock people out.
    const { body, tokens } = await signUp();
    await markUnverified(body.email);

    const res = await request(app).get(`${BASE}/me`).set("Authorization", `Bearer ${tokens.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.emailVerified).toBe(false);
  });
});

// --- Refresh rotation (AC-A22) ---------------------------------------------

describe("POST /refresh", () => {
  it("rotates: the new token works and the old one stops working", async () => {
    const { tokens } = await signUp();

    const first = await request(app).post(`${BASE}/refresh`).send({ refreshToken: tokens.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.data.refreshToken).not.toBe(tokens.refreshToken);

    await request(app).post(`${BASE}/refresh`).send({ refreshToken: tokens.refreshToken }).expect(401);
  });

  it("replaying a rotated token kills the whole family - AC-A22", async () => {
    const { tokens } = await signUp();

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
    const { body, tokens } = await signUp();
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
    const { tokens } = await signUp();
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

describe("POST /verify-email", () => {
  it("creates the verified account and returns the tokens - AC-A10", async () => {
    const { body, otp } = await startSignup();

    const res = await request(app).post(`${BASE}/verify-email`).send({ email: body.email, otp });

    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ email: body.email, emailVerified: true });
    expect(res.body.data.user.friendCode).toHaveLength(7);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");

    const user = await prisma.user.findUniqueOrThrow({ where: { email: body.email } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);

    // The code is spent, and the account it made is the only thing left.
    const pending = await prisma.pendingSignup.findFirstOrThrow({ where: { email: body.email } });
    expect(pending.consumedAt).not.toBeNull();
  });

  it("refuses to hand out tokens for an already-used code - AC-A12", async () => {
    const { body, otp } = await startSignup();
    await request(app).post(`${BASE}/verify-email`).send({ email: body.email, otp }).expect(201);

    // NOT idempotent on purpose: replaying a spent code must not sign anyone in,
    // or knowing an email address alone would be enough to get tokens.
    const again = await request(app).post(`${BASE}/verify-email`).send({ email: body.email, otp });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("OTP_INVALID");
  });

  it("refuses an expired code - AC-A11", async () => {
    const { body, otp } = await startSignup();

    await prisma.pendingSignup.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).post(`${BASE}/verify-email`).send({ email: body.email, otp });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("OTP_EXPIRED");
    expect(await prisma.user.count({ where: { email: body.email } })).toBe(0);
  });

  it("kills the code after 5 wrong guesses - BR-AUTH-4", async () => {
    const { body, otp } = await startSignup();
    const wrong = otp === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i++) {
      const res = await request(app).post(`${BASE}/verify-email`).send({ email: body.email, otp: wrong });
      expect(res.body.error.code).toBe("OTP_INVALID");
    }

    // Sixth try, this time with the RIGHT code: the code is spent regardless.
    const res = await request(app).post(`${BASE}/verify-email`).send({ email: body.email, otp });
    expect(res.body.error.code).toBe("OTP_ATTEMPTS_EXCEEDED");
    expect(await prisma.user.count({ where: { email: body.email } })).toBe(0);
  });

  it("issuing a new code kills the previous one - EC-A14", async () => {
    const { body, otp: oldOtp } = await startSignup();

    // Backdate the first request so the 1-per-minute limit does not block us.
    await prisma.pendingSignup.updateMany({ data: { createdAt: new Date(Date.now() - 5 * 60 * 1000) } });

    await request(app).post(`${BASE}/verify-email/resend`).send({ email: body.email }).expect(200);
    const newOtp = otpFromEmail((await waitForEmail(2)).text);
    expect(newOtp).not.toBe(oldOtp);

    const stale = await request(app).post(`${BASE}/verify-email`).send({ email: body.email, otp: oldOtp });
    expect(stale.status).toBe(400);
    await request(app).post(`${BASE}/verify-email`).send({ email: body.email, otp: newOtp }).expect(201);
  });

  it("resend says the same thing whether or not a signup is waiting - AC-A13", async () => {
    const { body } = await startSignup();

    // Rate-limited (inside the minute), and an address nobody has used. Both
    // must be indistinguishable from a real send, or this endpoint becomes a
    // "who is signing up?" oracle.
    const limited = await request(app).post(`${BASE}/verify-email/resend`).send({ email: body.email });
    const unknown = await request(app)
      .post(`${BASE}/verify-email/resend`)
      .send({ email: "nobody@example.com" });

    expect(limited.status).toBe(200);
    expect(limited.body).toEqual(unknown.body);

    await new Promise((r) => setTimeout(r, 100)); // give a second email a chance
    expect(sentEmails).toHaveLength(1); // neither call actually sent one
  });
});

// --- Password reset (AC-A15...A19, AC-A9) -----------------------------------

async function verifiedUserWithOtp() {
  const { body } = await signUp();

  await request(app).post(`${BASE}/forgot-password`).send({ email: body.email }).expect(200);
  const otp = otpFromEmail((await waitForEmail(2)).text);
  return { email: body.email, otp };
}

describe("POST /forgot-password", () => {
  it("says the same thing for verified, unverified and unknown emails - AC-A15, A16, BR-AUTH-10", async () => {
    const { body: verified } = await signUp();
    const { body: unverified } = await signUp();
    await markUnverified(unverified.email);
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
    const { body } = await signUp();
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
