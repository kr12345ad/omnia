// The trials drive a real Linux/X11 desktop (the KDE 1920x1080 repro), so a
// host that cannot provide one reports a skip instead of throwing against a
// missing X server.
export function desktopSkipReason(
  trial: string,
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (platform !== "linux") return `${trial} requires a Linux/X11 host; this host is ${platform}`
  const display = env.DISPLAY
  if (display === undefined || display.trim().length === 0) {
    return `${trial} requires an X11 display; DISPLAY is unset or empty`
  }
  return undefined
}

// The explicit arm for the live CLI. Building the real adapters is the step
// that can reach a display, so it happens only when the operator sets
// OMNIA_LIVE_HARNESS=1; the CLI then still refuses without a display rather
// than synthesising input into nothing.
export function liveHarnessSkipReason(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env.OMNIA_LIVE_HARNESS !== "1") return "OMNIA_LIVE_HARNESS is not set to 1"
  const display = env.DISPLAY
  if (display === undefined || display.trim().length === 0) return "DISPLAY is unset or empty"
  return undefined
}
