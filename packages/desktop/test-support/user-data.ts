import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Bun runs every test file in one process, and a module keeps the `electron`
// substitution it resolved when it was first imported, so a suite cannot count
// on its own plugin answering `app.getPath("userData")`. It can still choose
// the directory: the shared substitution answers with whichever suite
// activated its directory for the test at hand, and each suite claims a fresh
// one so it never inherits another suite's session or control-plane files.
const environment = "OMNIA_TEST_USER_DATA"
const fallback = mkdtempSync(join(tmpdir(), "omnia-desktop-userdata-"))

export function useTestUserData(prefix = "omnia-desktop-userdata-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function activateTestUserData(directory: string): void {
  process.env[environment] = directory
}

export function testUserData(): string {
  return process.env[environment] ?? fallback
}
