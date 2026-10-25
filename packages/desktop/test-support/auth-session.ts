import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Suites used to replace ./auth-session with `mock.module`, which is
// process-wide and outlives the file that installed it: every later suite then
// reads someone else's session. A real session file in the suite's own userData
// directory keeps the shipped module in place.
export function writeTestAuthSession(
  directory: string,
  session: { url: string; clientToken: string; profileId?: string | number } | undefined,
): void {
  const file = join(directory, "auth-session.json")
  if (session === undefined) {
    rmSync(file, { force: true })
    return
  }
  writeFileSync(
    file,
    JSON.stringify({
      url: session.url,
      clientToken: session.clientToken,
      ...(session.profileId === undefined ? {} : { profile: { id: session.profileId } }),
    }),
    { mode: 0o600 },
  )
}
