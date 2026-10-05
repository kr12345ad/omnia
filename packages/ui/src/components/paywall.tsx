import { createMediaQuery } from "@solid-primitives/media"
import { type ComponentProps, Match, Show, Switch, createMemo, createUniqueId, splitProps } from "solid-js"
import { useI18n } from "../context/i18n"
import { Button } from "./button"
import { Icon, type IconProps } from "./icon"
import "./paywall.css"

/**
 * What the billing API said about one capability.
 *
 * Deliberately the same shape as the decision `POST /billing/check` returns and
 * the per-capability entry of `GET /billing/entitlement`, so a caller can pass
 * the response through without reshaping it.
 */
export type PaywallCode = "granted" | "limit_reached" | "not_entitled" | "unknown"
export type PaywallMetering = "hard" | "soft"

export interface PaywallDecision {
  readonly code: PaywallCode
  /** `soft` means past a fair-use allowance but still working. */
  readonly metering?: PaywallMetering
  readonly used?: number
  readonly limit?: number
  /**
   * The server's own sentence. Without it a refusal had no explanation at all:
   * the decision object carried a code and two numbers, so a user whose feature
   * stopped working during our outage was shown nothing and left to guess.
   */
  readonly reason?: string
}

/**
 * The commercial half of the surface.
 *
 * Every field is a string the entitlement response supplied. Nothing about a
 * plan, a price or a billing period is assumed here, so a plan rename or a
 * price change is a server-side edit and never a component edit.
 */
export interface PaywallOffer {
  /** Display name of the plan being offered, e.g. "Pro". */
  readonly plan?: string
  /** Fully formatted price label, e.g. "$15 a month". */
  readonly price?: string
  /** Overrides the default action label. */
  readonly action?: string
  readonly onUpgrade?: () => void
}

export interface PaywallProps extends Omit<ComponentProps<"div">, "children" | "title"> {
  /** Capability id from the billing API, e.g. `remote_shell`. */
  capability: string
  decision?: PaywallDecision
  offer?: PaywallOffer
  /** Omit to render a persistent surface; supply it to offer a dismiss control. */
  onDismiss?: () => void
}

type Tone = "fair-use" | "used-up" | "locked"

const TONE_ICON: Readonly<Record<Tone, IconProps["name"]>> = {
  "fair-use": "circle-check",
  "used-up": "warning",
  locked: "shield",
}

const CAPABILITY_KEYS: Readonly<Record<string, string>> = {
  remote_shell: "ui.paywall.capability.remoteShell",
  clipboard: "ui.paywall.capability.clipboard",
  credential_vault: "ui.paywall.capability.credentialVault",
  vault_login: "ui.paywall.capability.vaultLogin",
  cloud_vision: "ui.paywall.capability.cloudVision",
  scheduled_runs: "ui.paywall.capability.scheduledRuns",
}

/**
 * Maps a decision to a tone, or to nothing at all.
 *
 * `granted` never renders a paywall. `unknown` is treated the same way on
 * purpose: that code means the billing store could not be read, so a paywall
 * would be telling somebody to pay for our outage. The enforcement layer
 * already reports its own failure; the UI stays quiet.
 */
function toneOf(decision: PaywallDecision | undefined): Tone | undefined {
  if (decision === undefined) return undefined
  if (decision.code === "limit_reached") return decision.metering === "soft" ? "fair-use" : "used-up"
  if (decision.code === "not_entitled") return "locked"
  return undefined
}

/**
 * An inline, dismissible upgrade surface for a metered capability.
 *
 * Deliberately not a dialog: it never takes focus, never traps it, and never
 * stands between the user and the thing they were trying to do. A soft limit
 * keeps the feature working, so it is announced as a notice rather than dressed
 * up as a failure.
 */
export function Paywall(props: PaywallProps) {
  const i18n = useI18n()
  const [local, rest] = splitProps(props, ["capability", "decision", "offer", "onDismiss", "class", "classList"])
  const titleId = createUniqueId()
  const reducedMotion = createMediaQuery("(prefers-reduced-motion: reduce)")

  const tone = createMemo(() => toneOf(local.decision))
  const capability = createMemo(() => {
    const key = CAPABILITY_KEYS[local.capability]
    return key === undefined ? local.capability : i18n.t(key)
  })
  const limit = createMemo(() => {
    const value = local.decision?.limit
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
  })
  const used = createMemo(() => {
    const value = local.decision?.used
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
  })
  const usage = createMemo(() => {
    const max = limit()
    if (max === undefined) return undefined
    const format = new Intl.NumberFormat(i18n.locale())
    return i18n.t("ui.paywall.usage", { used: format.format(used() ?? 0), limit: format.format(max) })
  })
  const usagePercent = createMemo(() => {
    const max = limit()
    if (max === undefined) return undefined
    return Math.min(100, Math.max(0, Math.round(((used() ?? 0) / max) * 100)))
  })

  return (
    <Show when={tone()}>
      {(current) => (
        <div
          {...rest}
          data-component="paywall"
          data-tone={current()}
          data-reduced-motion={reducedMotion() ? "true" : "false"}
          // A live region so a limit reached mid-session is announced politely.
          // `locked` is a standing explanation rather than news, so it is a
          // labelled group and stays out of the live region queue.
          role={current() === "locked" ? "group" : "status"}
          aria-labelledby={current() === "locked" ? titleId : undefined}
          classList={{
            ...local.classList,
            [local.class ?? ""]: !!local.class,
          }}
        >
          <span data-slot="paywall-icon" aria-hidden="true">
            <Icon name={TONE_ICON[current()]} size="small" />
          </span>
          <div data-slot="paywall-body">
            <span id={titleId} data-slot="paywall-title">
              <Switch>
                <Match when={current() === "fair-use"}>
                  {i18n.t("ui.paywall.fairUse.title", { capability: capability() })}
                </Match>
                <Match when={current() === "used-up"}>
                  {i18n.t("ui.paywall.usedUp.title", { capability: capability() })}
                </Match>
                <Match when={current() === "locked"}>
                  {i18n.t("ui.paywall.locked.title", { capability: capability() })}
                </Match>
              </Switch>
            </span>
            <span data-slot="paywall-description">
              {/* The server's sentence wins when there is one: it is the only
                  part that can explain an outage ("billing could not be reached")
                  rather than implying the customer did something wrong. */}
              <Show when={local.decision?.reason !== undefined && local.decision.reason.length > 0}>
                <span data-slot="paywall-reason">{local.decision?.reason}</span>
              </Show>
              <Switch>
                <Match when={current() === "fair-use"}>{i18n.t("ui.paywall.fairUse.description")}</Match>
                <Match when={current() === "used-up"}>{i18n.t("ui.paywall.usedUp.description")}</Match>
                <Match when={current() === "locked"}>
                  {local.offer?.plan === undefined || local.offer.plan.length === 0
                    ? i18n.t("ui.paywall.locked.description.generic", { capability: capability() })
                    : i18n.t("ui.paywall.locked.description", {
                        capability: capability(),
                        plan: local.offer.plan,
                      })}
                </Match>
              </Switch>
            </span>
            {/* The numbers are visible text on purpose: a bar nobody can read is
                how usage gets hidden. The bar itself is decoration. */}
            <Show when={usage()}>
              {(text) => (
                <span data-slot="paywall-usage">
                  <span data-slot="paywall-usage-track" aria-hidden="true">
                    <span data-slot="paywall-usage-fill" style={{ width: `${usagePercent()}%` }} />
                  </span>
                  <span data-slot="paywall-usage-text">{text()}</span>
                </span>
              )}
            </Show>
          </div>
          <div data-slot="paywall-actions">
            <Show when={local.offer?.price}>{(price) => <span data-slot="paywall-price">{price()}</span>}</Show>
            <Show when={local.offer?.onUpgrade}>
              <Button
                variant="primary"
                size="small"
                data-slot="paywall-upgrade"
                onClick={() => local.offer?.onUpgrade?.()}
              >
                {local.offer?.action ?? i18n.t("ui.paywall.upgrade")}
              </Button>
            </Show>
            <Show when={local.onDismiss}>
              <Button
                variant="ghost"
                size="small"
                data-slot="paywall-dismiss"
                aria-label={i18n.t("ui.paywall.dismiss")}
                onClick={() => local.onDismiss?.()}
              >
                <Icon name="close-small" size="small" />
              </Button>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}
