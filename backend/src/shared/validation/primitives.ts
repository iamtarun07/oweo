import { readFileSync } from "fs";
import path from "path";
import { z } from "zod";

/**
 * Every validation rule in PRD §26 lives HERE and nowhere else.
 * If a rule is written twice, the two copies will disagree eventually.
 */

/**
 * Top-10,000 leaked passwords, loaded once at boot into a Set (O(1) lookups).
 * A file + a Set is free and satisfies PRD §26.1 without any paid API.
 *
 * The path works from src/ (tsx) and dist/ (compiled) because both are the
 * same depth below backend/.
 */
const commonPasswords = new Set(
  readFileSync(path.resolve(__dirname, "../../../data/common-passwords.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
);

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "Email is too long.")
  .email("Enter a valid email address.");

export const nameSchema = z
  .string()
  .trim()
  // Collapse runs of inner spaces: "Tarun   Kumar" -> "Tarun Kumar".
  .transform((v) => v.replace(/\s+/g, " "))
  .refine((v) => v.length >= 1 && v.length <= 40, "Use between 1 and 40 characters.")
  // Letters, spaces, hyphens and apostrophes only — no digits, emoji or control
  // characters. \p{L} with the u flag covers accented and non-Latin letters.
  .refine((v) => /^[\p{L}][\p{L} '-]*$/u.test(v), "Use letters, spaces, hyphens and apostrophes only.");

export const passwordSchema = z
  // NO .trim() here, ever. PRD EC-A11: a password must be compared exactly as
  // typed, spaces included. Trimming would silently lock people out.
  .string()
  .min(8, "Use at least 8 characters.")
  .max(128, "Use at most 128 characters.")
  .refine((v) => !commonPasswords.has(v.toLowerCase()), "This password is too common. Pick another.");

/** 31 symbols: 0, O, 1, I and L are left out because people misread them. */
export const FRIEND_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export const friendCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  // People type "ab7 k92-x"; accept it and clean it up rather than refusing.
  .transform((v) => v.replace(/[\s-]/g, ""))
  .refine((v) => v.length === 7, "A friend code is 7 characters.")
  .refine(
    (v) => [...v].every((ch) => FRIEND_CODE_ALPHABET.includes(ch)),
    "That friend code contains characters we do not use."
  );

export const otpSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code.");
