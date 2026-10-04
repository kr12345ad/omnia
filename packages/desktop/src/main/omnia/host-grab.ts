// Test-only shared state for the platform-driver double used by the desktop
// suite. Bun keeps one module registry per process, so the two suites that mock
// "./server-host" must close over the same object for the grab-wiring
// assertions to be independent of which file loads first.
export const hostGrab = {
  subscriptions: 0,
  listener: undefined as ((event: { type: string; releasedBy?: string }) => void) | undefined,
}

export function recordGrabSubscription(listener: (event: { type: string; releasedBy?: string }) => void) {
  hostGrab.subscriptions += 1
  hostGrab.listener = listener
  return () => {
    if (hostGrab.listener === listener) hostGrab.listener = undefined
  }
}