import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { safeStorage } from "electron"

// Ad-hoc signed macOS builds get a new code signature on every rebuild, so the
// "Omnia Safe Storage" keychain item's ACL stops matching the app and macOS
// prompts for the login keychain on every access. Until the app is signed with
// a stable Developer ID, macOS keeps secrets in owner-only files instead
// (0o600). Set OMNIA_SAFE_STORAGE=1 to opt back in.
export function osEncryptionAvailable(): boolean {
  if (process.env.OMNIA_SAFE_STORAGE === "0") return false
  if (process.platform === "darwin" && process.env.OMNIA_SAFE_STORAGE !== "1") return false
  return safeStorage.isEncryptionAvailable()
}

export function encryptString(value: string): string | undefined {
  if (!osEncryptionAvailable()) return undefined
  return safeStorage.encryptString(value).toString("base64")
}

// "No keychain" and "ciphertext this keychain can never open" are different
// failures: the first is recoverable by turning encryption on, the second means
// the stored secret is gone (a reinstalled app, a rotated keychain item) and
// must be reported instead of being mistaken for a signed-out user.
export type SecretReadResult = { readonly value: string } | { readonly failure: "unavailable" | "unreadable" }

export function readSecret(value: string): SecretReadResult {
  if (!osEncryptionAvailable()) return { failure: "unavailable" }
  try {
    return { value: safeStorage.decryptString(Buffer.from(value, "base64")) }
  } catch {
    return { failure: "unreadable" }
  }
}

export function decryptString(value: string): string | undefined {
  const result = readSecret(value)
  return "failure" in result ? undefined : result.value
}

// Credentials on disk are written through a fresh owner-only file that is
// renamed into place: `writeFileSync(..., { mode })` only applies the mode at
// creation, truncates in place (so a crash leaves a half-written token), and
// follows a symlink an attacker planted at the target path.
export function writeSecretFile(file: string, contents: string): void {
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Refusing to write ${file} through a symlink.`)
  }
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${basename(file)}.${randomUUID()}.tmp`)
  try {
    // `wx` never follows a planted symlink, and 0600 never exposes the secret
    // even for the instant the file exists.
    const handle = openSync(temporary, "wx", 0o600)
    try {
      writeFileSync(handle, contents)
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    // rename(2) inside one directory is atomic, so a crash or a full disk
    // leaves either the previous secret or this one, never a torn mix.
    renameSync(temporary, file)
  } catch (error) {
    // A temp file left behind is dead weight holding a credential; never keep one.
    try {
      unlinkSync(temporary)
    } catch {
      // Already gone, or the directory is gone with it.
    }
    throw error
  }
  // Rename keeps the temp file's mode, but an existing file may predate this
  // call with looser permissions.
  chmodSync(file, 0o600)
}