import { createEffect, createSignal, on } from "solid-js"
import { Paywall } from "@opencode-ai/ui/paywall"
import { useEntitlement } from "@/context/entitlement"
import { useSessionLayout } from "@/pages/session/session-layout"

/**
 * The remote shell notice, in a place that can be read.
 *
 * The terminal panel is `inert` and `aria-hidden` until somebody opens it, so a
 * refusal explained only inside that panel is explained to nobody: not to the
 * person looking at the screen, and not to a screen reader. This renders the same
 * surface beside the composer, which is always in the accessibility tree, and the
 * panel keeps its own copy for whoever opens it deliberately.
 *
 * It waits until the user has asked for a shell. A limit notice that greets
 * every session uninvited is how a notice stops being read, and it is also why
 * the decision is not asked for until then.
 */
export function RemoteShellNotice() {
  const entitlement = useEntitlement()
  const { view } = useSessionLayout()
  const opened = () => view().terminal.opened()
  // Latched, because the panel closes itself again once its last terminal is
  // gone: the refusal it explains does not expire with the panel.
  const [asked, setAsked] = createSignal(opened())

  createEffect(on(opened, (value) => setAsked((current) => current || value)))
  createEffect(() => {
    if (!asked()) return
    void entitlement.check("remote_shell")
  })

  return (
    <Paywall
      capability="remote_shell"
      // Both conditions hide the surface by withholding the decision, which is
      // what `Paywall` already renders nothing for, so there is no second way
      // for this notice to be half-drawn.
      decision={asked() && !entitlement.dismissed("remote_shell") ? entitlement.decision("remote_shell") : undefined}
      offer={entitlement.offer()}
      onDismiss={() => entitlement.dismiss("remote_shell")}
      class="mx-2 mt-2"
    />
  )
}
