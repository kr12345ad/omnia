import { createEffect, createSignal, on } from "solid-js"
import { Paywall, type PaywallDecision, type PaywallOffer } from "@opencode-ai/ui/paywall"
import type { PromptInputV2Attachment } from "./types"

/** The metered capabilities this composer can surface a notice about. */
export type PromptInputV2Capability = "cloud_vision" | "remote_shell"

/**
 * Entitlement answers the parent supplies for the composer.
 *
 * Every field is optional on purpose and there is no provider behind them:
 * `packages/app` owns the entitlement snapshot and the billing bridge, and this
 * package must not reach across into it. A parent that has no answer therefore
 * passes nothing, and nothing is the correct rendering for a signed-out
 * profile, a server with no billing configured, and a control plane that could
 * not be reached - all three read as "no answer", and a notice in any of those
 * cases would be billing somebody for our outage.
 *
 * `onDismiss` is required rather than optional so a notice can never arrive
 * without a way to close it. The surface is inline and never a modal, but an
 * inline notice with no dismiss is a notice the user cannot get rid of either.
 */
export type PromptInputV2Paywalls = {
  /** What an attached image costs. Absent means "not answered", not "free". */
  cloudVision?: PaywallDecision
  /** What the shell inside this composer costs. */
  remoteShell?: PaywallDecision
  /** What to offer beside a refusal. Without it no upgrade button is drawn. */
  offer?: PaywallOffer
  onDismiss: (capability: PromptInputV2Capability) => void
}

/**
 * Only an image costs vision, so a text attachment never earns a notice.
 *
 * A paywall under a `.txt` attachment would be charging for reading a file the
 * model can read without leaving the machine.
 */
export function promptInputV2VisionOwed(attachments: PromptInputV2Attachment[]) {
  return attachments.some((attachment) => attachment.mime.startsWith("image/"))
}

/**
 * Whether the shell has been asked for at least once.
 *
 * Latched because shell mode closes itself again when the user leaves it, and a
 * refusal does not expire with the mode. It is also why the decision is only read
 * once somebody has asked for a shell: a limit notice that greets every session
 * uninvited is how a notice stops being read.
 */
export function promptInputV2ShellAsked(asked: boolean, opened: boolean) {
  return asked || opened
}

export function PromptInputV2Paywall(props: {
  capability: PromptInputV2Capability
  decision?: PaywallDecision
  offer?: PaywallOffer
  onDismiss?: () => void
  class?: string
}) {
  return (
    <Paywall
      capability={props.capability}
      decision={props.decision}
      offer={props.offer}
      onDismiss={props.onDismiss}
      class={props.class}
    />
  )
}

/**
 * The remote shell notice, beside the composer that runs the shell.
 *
 * This delegates every semantic to the shared `Paywall`, so `granted` draws
 * nothing, a soft limit is announced as a working-feature notice rather than a
 * failure, a hard refusal and `not_entitled` get the upgrade affordance, and an
 * unanswered or unreadable decision draws nothing and gates nothing.
 */
export function PromptInputV2ShellPaywall(props: {
  decision?: PaywallDecision
  offer?: PaywallOffer
  opened: boolean
  onDismiss?: () => void
  class?: string
}) {
  const [asked, setAsked] = createSignal(props.opened)
  createEffect(on(() => props.opened, (value) => setAsked((current) => promptInputV2ShellAsked(current, value))))
  return (
    <PromptInputV2Paywall
      capability="remote_shell"
      // Withholding the decision is how `Paywall` already renders nothing, so
      // there is no second way for this notice to be half-drawn.
      decision={asked() ? props.decision : undefined}
      offer={props.offer}
      onDismiss={props.onDismiss}
      class={props.class}
    />
  )
}