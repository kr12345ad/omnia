/**
 * Re-forks the app's sidecar when the control-plane session changes.
 *
 * The sidecar forks with the control-plane credentials in its environment (see
 * `createSidecarEnv`), and the Omnia computer tools only register while both are
 * present. Nothing re-reads them afterwards, so a sign-in that landed after the
 * app had already started left `switch_computer` and every other computer tool
 * off the agent's tool list for the rest of the launch, in every session mode.
 *
 * The fingerprint this watch remembers is the one the running sidecar was forked
 * with, and it only advances once a restart has succeeded, so a restart that
 * fails is retried on the next tick instead of being recorded as applied.
 */
export type ControlPlaneSessionWatch = {
  /** The session fingerprint the running sidecar was forked with. */
  applied: () => string | undefined
  /** Re-forks when the session no longer matches the one the sidecar has. */
  sync: () => Promise<void>
  stop: () => void
}

export function watchControlPlaneSession(input: {
  fingerprint: () => string | undefined
  restart: () => Promise<void>
  intervalMs: number
  onError: (error: unknown) => void
}): ControlPlaneSessionWatch {
  let applied = input.fingerprint()
  let restarting = false

  // A restart takes longer than a tick: keep the restart in flight and let a
  // later tick pick up whatever the session settled on by then.
  async function sync() {
    if (restarting) return
    const next = input.fingerprint()
    if (next === applied) return
    restarting = true
    try {
      await input.restart()
      applied = next
    } catch (error) {
      input.onError(error)
    } finally {
      restarting = false
    }
  }

  const timer = setInterval(() => void sync(), input.intervalMs)
  timer.unref?.()

  return {
    applied: () => applied,
    sync,
    stop: () => clearInterval(timer),
  }
}
