import { createHmac } from "crypto";
import type { CredentialProfile } from "../types.js";

/**
 * One-time codes for credential profiles: RFC 6238 TOTP from `totp_secret`,
 * or the profile's `fixed_otp` (a test environment's static code). Shared by
 * the flow runner and the task agent.
 *
 * The secret never leaves this module: callers get a code, never the key,
 * and errors say what is wrong with it without echoing it.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode an RFC 4648 base32 secret the way authenticator apps show it: any
 * case, with spaces, dashes and trailing padding allowed.
 */
export function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean) throw new Error("TOTP secret is empty");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error("TOTP secret is not valid base32 (letters A-Z and digits 2-7)");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  /** Unix time in milliseconds. Default: now. */
  time?: number;
  /** Seconds each code is valid for. Default 30. */
  step?: number;
  /** Code length. Default 6. */
  digits?: number;
}

/** RFC 6238 TOTP with HMAC-SHA1: what authenticator apps generate by default. */
export function generateTOTP(secret: string, options: TotpOptions = {}): string {
  const { time = Date.now(), step = 30, digits = 6 } = options;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / step)));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  // RFC 4226 dynamic truncation: 31 bits starting at the offset the last nibble names.
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Whole seconds until the code for `time` is replaced by the next one. */
export function totpSecondsLeft(time: number = Date.now(), step: number = 30): number {
  return step - (Math.floor(time / 1000) % step);
}

export interface OneTimeCode {
  code: string;
  source: "fixed_otp" | "totp";
  /** TOTP only: seconds before this code is replaced. */
  expiresInSeconds?: number;
}

/** Whether a profile can produce a one-time code. */
export function hasOneTimeCode(profile: CredentialProfile): boolean {
  return !!(profile.fixed_otp || profile.totp_secret);
}

/**
 * The code to enter for a profile: `fixed_otp` when it is set, otherwise the
 * current TOTP from `totp_secret`. Null when the profile has neither.
 *
 * With `minValidSeconds`, a TOTP code about to expire is skipped by waiting
 * for the next one, so it is not already stale by the time it is submitted.
 */
export async function oneTimeCode(
  profile: CredentialProfile,
  minValidSeconds: number = 0
): Promise<OneTimeCode | null> {
  // YAML reads an unquoted 123456 as a number.
  if (profile.fixed_otp) return { code: String(profile.fixed_otp), source: "fixed_otp" };
  if (!profile.totp_secret) return null;
  const secret = String(profile.totp_secret);
  base32Decode(secret); // a bad secret fails now, not after the wait
  let now = Date.now();
  if (totpSecondsLeft(now) < minValidSeconds) {
    await new Promise((resolve) => setTimeout(resolve, totpSecondsLeft(now) * 1000));
    now = Date.now();
  }
  return {
    code: generateTOTP(secret, { time: now }),
    source: "totp",
    expiresInSeconds: totpSecondsLeft(now),
  };
}
