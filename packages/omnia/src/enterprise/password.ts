// Password storage for the enterprise control plane.
//
// scrypt is the KDF because it is in Node's standard library, has no native
// build step, and is memory-hard. Parameters are stored with the hash so a
// future cost increase verifies old passwords and upgrades them on next login.
//
// The only thing a caller ever sees is the encoded string. A wrong password and
// an unknown user both cost a verification, so a login probe cannot time the
// difference between "no such account" and "wrong password".

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 256

const N = 16384
const R = 8
const P = 1
const KEY_LENGTH = 64
const SALT_LENGTH = 16

// 64 MiB is the default scrypt limit; the exact requirement here is 128*N*r.
const MAX_MEM = 64 * 1024 * 1024

export function passwordProblem(password: string): string | undefined {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`
  if (password.trim().length !== password.length) return "Password must not begin or end with whitespace."
  return undefined
}

export async function hashPassword(password: string): Promise<string> {
  const problem = passwordProblem(password)
  if (problem !== undefined) throw new Error(problem)
  const salt = randomBytes(SALT_LENGTH)
  const derived = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEM })
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${derived.toString("base64url")}`
}

/**
 * Verify a password against an encoded hash.
 *
 * A malformed hash verifies as false rather than throwing, because a corrupt
 * record must fail the login rather than produce a 500 that tells an attacker
 * the account exists.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$")
  if (parts.length !== 6 || parts[0] !== "scrypt") return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false
  if (n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4]!, "base64url")
    expected = Buffer.from(parts[5]!, "base64url")
  } catch {
    return false
  }
  if (salt.length < 8 || expected.length < 16) return false
  if (128 * n * r > MAX_MEM) return false
  try {
    const actual = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: MAX_MEM })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/**
 * Burn the same KDF work as a real verification when there is no user. Login
 * uses this for unknown accounts so response time does not reveal which
 * addresses exist.
 */
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$" +
  "Y2FsaWJyYXRpb24tb25seS1ub3QtYS1yZWFsLXBhc3N3b3JkLWhhc2gtZm9yLXRpbWluZw"

export async function burnPasswordCheck(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH)
}
