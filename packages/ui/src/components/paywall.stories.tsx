// @ts-nocheck
import * as mod from "./paywall"
import { create } from "../storybook/scaffold"

const docs = `### Overview
Inline upgrade surface for a metered capability. Shows the capability name, what
upgrading adds, current usage against the limit when there is one, and a single
upgrade action.

### API
- \`capability\`: capability id from the billing API, e.g. \`remote_shell\`.
- \`decision\`: the server decision, passed straight through.
- \`offer\`: plan name, price label and upgrade handler, all supplied by the
  entitlement response. No plan name or price is hardcoded.
- \`onDismiss\`: supply to offer a dismiss control; omit for a persistent surface.

### Decision codes
- \`granted\`: renders nothing. A capability that is granted never shows a paywall.
- \`unknown\`: renders nothing. This code means the billing store could not be
  read, and billing the user for our outage would be dishonest.
- \`limit_reached\` + \`metering: "soft"\`: a notice. The feature still works and the
  copy says so; it is never styled as an error.
- \`limit_reached\` + \`metering: "hard"\`: the allowance is spent.
- \`not_entitled\`: not in the current plan, so the copy explains what upgrading adds.

### Behavior
Never a dialog. It does not take focus, does not trap it, and never stands
between the user and the feature. Usage numbers are visible text, not a bar alone.

### Accessibility
- Fair-use and used-up are polite live regions (\`role="status"\`); locked is a
  labelled \`role="group"\`.
- Actions are real buttons in DOM order, so they are keyboard reachable.
- The usage bar is decorative; the numbers beside it are the accessible content.
- Honours \`prefers-reduced-motion\` and exposes \`data-reduced-motion\`.

### Theming/tokens
Uses \`data-component="paywall"\` with a \`data-tone\` attribute
(\`fair-use\`, \`used-up\`, \`locked\`).

`

const offer = { plan: "Pro", price: "$15 a month", onUpgrade: () => undefined }
const story = create({
  title: "UI/Paywall",
  mod,
  args: {
    capability: "remote_shell",
    decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300 },
    offer,
  },
})

export default {
  title: "UI/Paywall",
  id: "components-paywall",
  component: story.meta.component,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
  argTypes: {
    capability: {
      control: "select",
      options: ["remote_shell", "clipboard", "credential_vault", "vault_login", "cloud_vision", "scheduled_runs"],
    },
  },
}

export const Basic = story.Basic

export const FairUse = {
  args: {
    decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300 },
  },
}

export const UsedUp = {
  args: {
    decision: { code: "limit_reached", metering: "hard", used: 3, limit: 3 },
  },
}

export const NotEntitled = {
  args: {
    decision: { code: "not_entitled", metering: "hard", used: 0, limit: 0 },
  },
}

export const UnmeteredFairUse = {
  args: {
    decision: { code: "limit_reached", metering: "soft", used: 4_200 },
  },
}

export const Dismissible = {
  args: {
    onDismiss: () => undefined,
    decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300 },
  },
}

export const NothingToShow = {
  render: () => (
    <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
      <mod.Paywall capability="remote_shell" decision={{ code: "granted", used: 12, limit: 300 }} offer={offer} />
      <mod.Paywall capability="remote_shell" decision={{ code: "unknown", used: 0, limit: 3 }} offer={offer} />
      <span style={{ color: "var(--text-weak)", "font-size": "12px" }}>
        Granted and unknown both render nothing at all.
      </span>
    </div>
  ),
}

export const Capabilities = {
  render: () => (
    <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
      {["remote_shell", "clipboard", "credential_vault", "vault_login", "cloud_vision", "scheduled_runs"].map(
        (capability) => (
          <mod.Paywall
            capability={capability}
            decision={{ code: "not_entitled", metering: "hard", used: 0, limit: 0 }}
            offer={offer}
          />
        ),
      )}
    </div>
  ),
}
