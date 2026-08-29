import { randomInt } from "crypto";
import { FRIEND_CODE_ALPHABET } from "../validation/primitives";

/**
 * A 7-character code people read aloud and type in, so the alphabet leaves out
 * 0/O and 1/I/L (PRD §12.1). 31^7 is about 27.5 billion codes.
 *
 * randomInt(0, 31) instead of randomBytes(1)[0] % 31: 256 is not a multiple of
 * 31, so the modulo version would produce the first few letters slightly more
 * often. randomInt handles that correctly and keeps every code equally likely.
 */
export function generateFriendCode(): string {
  let code = "";
  for (let i = 0; i < 7; i++) {
    code += FRIEND_CODE_ALPHABET[randomInt(0, FRIEND_CODE_ALPHABET.length)];
  }
  return code;
}
