import { describe, expect, it } from "vitest";

import { generateFriendCode } from "./friendCode";
import { hashPassword, verifyPassword } from "./password";
import { generateNumericOtp, generateOpaqueToken, hashToken } from "./tokens";
import { FRIEND_CODE_ALPHABET } from "../validation/primitives";

/**
 * These need no database and no server, so they run in a second.
 * Run them with: npm test
 */

describe("password", () => {
  it("produces a different hash every time, and both verify", async () => {
    // Different hashes prove a random salt is being used. Identical hashes
    // would mean one leaked rainbow table cracks every account at once.
    const a = await hashPassword("correct-horse-battery");
    const b = await hashPassword("correct-horse-battery");

    expect(a).not.toBe(b);
    expect(await verifyPassword("correct-horse-battery", a)).toBe(true);
    expect(await verifyPassword("correct-horse-battery", b)).toBe(true);
  });

  it("returns false for a wrong password instead of throwing", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("returns false for a corrupt hash instead of throwing", async () => {
    expect(await verifyPassword("anything", "not-a-real-hash")).toBe(false);
  });

  it("treats trailing spaces as part of the password (PRD EC-A11)", async () => {
    const hash = await hashPassword("my password ");
    expect(await verifyPassword("my password", hash)).toBe(false);
    expect(await verifyPassword("my password ", hash)).toBe(true);
  });
});

describe("friend code", () => {
  it("generates 7 characters from the safe alphabet, with no repeats in 10k", () => {
    const codes = new Set<string>();

    for (let i = 0; i < 10_000; i++) {
      const code = generateFriendCode();
      expect(code).toHaveLength(7);
      expect([...code].every((ch) => FRIEND_CODE_ALPHABET.includes(ch))).toBe(true);
      codes.add(code);
    }

    // 10,000 draws from 27.5 billion: a duplicate here means the generator is
    // not actually random.
    expect(codes.size).toBe(10_000);
  });
});

describe("tokens", () => {
  it("hashes the same token to the same value, different tokens to different values", () => {
    const token = generateOpaqueToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(generateOpaqueToken()));
    expect(hashToken(token)).toHaveLength(64); // SHA-256 as hex
  });

  it("generates 6-digit OTPs, keeping leading zeros", () => {
    for (let i = 0; i < 2_000; i++) {
      expect(generateNumericOtp()).toMatch(/^\d{6}$/);
    }
  });
});
