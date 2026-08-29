export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** `now + ms`, as a Date. Keeps expiry maths readable at the call site. */
export function fromNow(ms: number, now = new Date()): Date {
  return new Date(now.getTime() + ms);
}

/** Whole minutes from now until `date`, never below 1 (for "try again in N"). */
export function minutesUntil(date: Date, now = new Date()): number {
  return Math.max(1, Math.ceil((date.getTime() - now.getTime()) / MINUTE_MS));
}

/**
 * "15m" -> 900. Used for the access-token lifetime, which env stores as a
 * readable string but jsonwebtoken wants as a plain number of seconds.
 */
export function durationToSeconds(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] as "s" | "m" | "h" | "d";
  return amount * { s: 1, m: 60, h: 3600, d: 86400 }[unit];
}
