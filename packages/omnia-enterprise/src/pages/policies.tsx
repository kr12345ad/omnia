import { Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import { api } from "@/lib/api"
import { navigate } from "@/lib/router"
import { useSession, useToast } from "@/state"
import {
  Button,
  Card,
  Field,
  InlineNote,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Switch,
  Tag,
  Textarea,
} from "@/components/ui"
import type { Policies } from "@/types"
import "./governance.css"

type Errors = Record<string, string>

function lines(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry, index, all) => all.indexOf(entry) === index)
}

function numberValue(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

export function PoliciesPage() {
  const session = useSession()
  const toast = useToast()
  const [loaded, { refetch }] = createResource(async () => api.policies())
  const [draft, setDraft] = createSignal<Policies | null>(null)
  const [saved, setSaved] = createSignal<Policies | null>(null)
  const [errors, setErrors] = createSignal<Errors>({})
  const [serverError, setServerError] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)

  // The resource is the one way the baseline enters the page. It only seeds the
  // draft once, so a background refetch cannot overwrite edits in progress.
  createEffect(() => {
    const policies = loaded()?.policies
    if (policies === undefined) return
    setDraft((current) => current ?? structuredClone(policies))
    setSaved((current) => current ?? structuredClone(policies))
  })
  const update = (change: (current: Policies) => Policies) => {
    setDraft((current) => (current === null ? current : change(current)))
    setServerError(undefined)
  }

  const dirty = createMemo(() => {
    const current = draft()
    const base = saved()
    if (current === null || base === null) return false
    return JSON.stringify(current) !== JSON.stringify(base)
  })

  const writable = () => session.can("policies:write")

  const validate = (value: Policies): Errors => {
    const result: Errors = {}
    if (!Number.isInteger(value.sessionHours) || value.sessionHours < 1 || value.sessionHours > 720) {
      result.sessionHours = "Session length must be between 1 and 720 hours."
    }
    if (!Number.isInteger(value.idleTimeoutMinutes) || value.idleTimeoutMinutes < 5 || value.idleTimeoutMinutes > 1_440) {
      result.idleTimeout = "Idle timeout must be between 5 and 1,440 minutes."
    }
    if (!Number.isInteger(value.data.retentionDays) || value.data.retentionDays < 1 || value.data.retentionDays > 3_650) {
      result.retention = "Data retention must be between 1 and 3,650 days."
    }
    if (!Number.isInteger(value.audit.retentionDays) || value.audit.retentionDays < 1 || value.audit.retentionDays > 3_650) {
      result.auditRetention = "Audit retention must be between 1 and 3,650 days."
    }
    if (value.audit.siemWebhook !== undefined && value.audit.siemWebhook.length > 0 && !isUrl(value.audit.siemWebhook)) {
      result.siem = "Enter a valid http(s) URL, or leave this empty."
    }
    return result
  }

  const save = async () => {
    const current = draft()
    if (current === null) return
    const found = validate(current)
    setErrors(found)
    if (Object.keys(found).length > 0) {
      toast.push("Some policy values need attention.", "error")
      return
    }
    setSaving(true)
    setServerError(undefined)
    try {
      const response = await api.savePolicies(current)
      const next = response.policies
      setDraft(structuredClone(next))
      setSaved(structuredClone(next))
      toast.push("Policies saved and recorded in the audit log.", "success")
      void refetch()
    } catch (cause) {
      setServerError(cause instanceof Error ? cause.message : "The policies could not be saved.")
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    const base = saved()
    if (base === null) return
    setDraft(structuredClone(base))
    setErrors({})
    setServerError(undefined)
  }

  return (
    <div class="ent-page">
      <PageHeader
        kicker="Governance"
        title="Policies"
        description="Organization-wide guardrails for every client build and session. These apply beneath each build's own settings: a build can be stricter, never looser."
        actions={
          <>
            <Button variant="ghost" icon="reset" disabled={!dirty() || !writable()} onClick={reset}>
              Reset
            </Button>
            <Button
              variant="primary"
              icon="check"
              loading={saving()}
              disabled={!dirty() || !writable()}
              onClick={() => void save()}
            >
              Save changes
            </Button>
          </>
        }
      />

      <Show when={!writable()}>
        <div style={{ "margin-bottom": "14px" }}>
          <InlineNote tone="neutral" icon="eye">
            Your role can review policies but not change them. Ask an owner or administrator to edit.
          </InlineNote>
        </div>
      </Show>

      <Show when={loaded.loading}>
        <div class="ent-stack">
          <Skeleton height={160} />
          <Skeleton height={220} />
          <Skeleton height={180} />
        </div>
      </Show>

      <Show when={loaded.error}>
        <InlineNote tone="danger" icon="warning">
          {loaded.error instanceof Error ? loaded.error.message : "The policies could not be loaded."}
        </InlineNote>
      </Show>

      <Show when={draft()}>
        {(currentAccessor) => {
          const current = () => currentAccessor()
          return (
                  <div class="ent-stack ent-policy-stack">
                    <Show when={serverError()}>
                      <InlineNote tone="danger" icon="warning">
                        {serverError()}
                      </InlineNote>
                    </Show>

                    <div class="ent-policy-columns">
                      <div class="ent-stack">
                    <Card
                      title="Sessions & access"
                      description="How long a console or client session lasts, and where it may be used from."
                      actions={<Tag tone="accent">Security</Tag>}
                    >
                      <div class="ent-form-grid">
                        <Field
                          label="Session length (hours)"
                          hint="1–720. Applies to console sessions and client enrollment."
                          error={errors().sessionHours}
                        >
                          <Input
                            type="number"
                            min={1}
                            max={720}
                            value={current().sessionHours}
                            disabled={!writable()}
                            onInput={(value) =>
                              update((draftValue) => ({ ...draftValue, sessionHours: numberValue(value, 12) }))
                            }
                          />
                        </Field>
                        <Field
                          label="Idle timeout (minutes)"
                          hint="5–1,440. An idle console session is revoked after this."
                          error={errors().idleTimeout}
                        >
                          <Input
                            type="number"
                            min={5}
                            max={1440}
                            value={current().idleTimeoutMinutes}
                            disabled={!writable()}
                            onInput={(value) =>
                              update((draftValue) => ({ ...draftValue, idleTimeoutMinutes: numberValue(value, 120) }))
                            }
                          />
                        </Field>
                        <div class="ent-span-2">
                          <Switch
                            checked={current().requireMfa}
                            disabled={!writable()}
                            onChange={(value) => update((draftValue) => ({ ...draftValue, requireMfa: value }))}
                            label="Require multi-factor authentication"
                            description="Recorded here and published to client builds. Enforce MFA at your identity provider; this server's local password login does not implement TOTP itself."
                          />
                        </div>
                        <div class="ent-span-2">
                          <Field
                            label="IP allowlist"
                            hint="One entry per line. Exact addresses, dotted prefixes (10.0.0.) and CIDR (192.168.1.0/24) are accepted. Empty allows every address."
                          >
                            <Textarea
                              rows={4}
                              value={current().ipAllowlist.join("\n")}
                              disabled={!writable()}
                              placeholder={"203.0.113.10\n10.0.0.\n192.168.1.0/24"}
                              onInput={(value) =>
                                update((draftValue) => ({ ...draftValue, ipAllowlist: lines(value) }))
                              }
                            />
                          </Field>
                        </div>
                      </div>
                    </Card>

                    <Card
                      title="Model access"
                      description="A floor for every build. An individual distribution can narrow these further."
                      actions={
                        <Tag tone={current().model.mode === "allowlist" ? "success" : "neutral"}>
                          {current().model.mode === "allowlist" ? "Allowlist" : "Denylist"}
                        </Tag>
                      }
                    >
                      <div class="ent-form-grid">
                        <div class="ent-span-2">
                          <div class="ent-radio-cards">
                            <button
                              type="button"
                              class="ent-radio-card"
                              data-active={current().model.mode === "allowlist" ? "" : undefined}
                              disabled={!writable()}
                              onClick={() => update((draftValue) => ({ ...draftValue, model: { ...draftValue.model, mode: "allowlist" } }))}
                            >
                              <strong>Allowlist</strong>
                              <span>Only the models you name can be used. Nothing else is reachable.</span>
                            </button>
                            <button
                              type="button"
                              class="ent-radio-card"
                              data-active={current().model.mode === "denylist" ? "" : undefined}
                              disabled={!writable()}
                              onClick={() => update((draftValue) => ({ ...draftValue, model: { ...draftValue.model, mode: "denylist" } }))}
                            >
                              <strong>Denylist</strong>
                              <span>Every model is allowed except the ones you block.</span>
                            </button>
                          </div>
                        </div>
                        <div class="ent-span-2">
                          <Field
                            label={current().model.mode === "allowlist" ? "Allowed models" : "Blocked models"}
                            hint="One model id per line, for example opencode/big or anthropic/claude-sonnet-4."
                          >
                            <Textarea
                              rows={5}
                              value={current().model.models.join("\n")}
                              disabled={!writable()}
                              placeholder={"opencode/big\nanthropic/claude-sonnet-4"}
                              onInput={(value) =>
                                update((draftValue) => ({
                                  ...draftValue,
                                  model: { ...draftValue.model, models: lines(value) },
                                }))
                              }
                            />
                          </Field>
                        </div>
                        <div class="ent-span-2">
                          <Switch
                            checked={current().model.requireApprovalForNewModels}
                            disabled={!writable()}
                            onChange={(value) =>
                              update((draftValue) => ({
                                ...draftValue,
                                model: { ...draftValue.model, requireApprovalForNewModels: value },
                              }))
                            }
                            label="Require approval before a new model is used"
                            description="A newly added provider or model stays unavailable until an administrator adds it here."
                          />
                        </div>
                      </div>
                    </Card>

                    <Card
                      title="Data & retention" description="What the deployment stores, for how long, and where.">
                      <div class="ent-form-grid">
                        <Field label="Conversation retention (days)" error={errors().retention}>
                          <Input
                            type="number"
                            min={1}
                            max={3650}
                            value={current().data.retentionDays}
                            disabled={!writable()}
                            onInput={(value) =>
                              update((draftValue) => ({
                                ...draftValue,
                                data: { ...draftValue.data, retentionDays: numberValue(value, 365) },
                              }))
                            }
                          />
                        </Field>
                        <Field label="Data residency">
                          <Select
                            value={current().data.residency}
                            disabled={!writable()}
                            onChange={(value) =>
                              update((draftValue) => ({ ...draftValue, data: { ...draftValue.data, residency: value } }))
                            }
                            options={[
                              { value: "self-hosted", label: "Self-hosted (this server)" },
                              { value: "us", label: "United States" },
                              { value: "eu", label: "European Union" },
                              { value: "apac", label: "Asia Pacific" },
                            ]}
                          />
                        </Field>
                        <div class="ent-span-2 ent-toggle-grid">
                          <Switch
                            checked={current().data.allowTraining}
                            disabled={!writable()}
                            onChange={(value) =>
                              update((draftValue) => ({ ...draftValue, data: { ...draftValue.data, allowTraining: value } }))
                            }
                            label="Allow usage for model training"
                            description="Off by default. Leave off unless your provider contract explicitly permits it."
                          />
                          <Switch
                            checked={current().data.redactSecrets}
                            disabled={!writable()}
                            onChange={(value) =>
                              update((draftValue) => ({ ...draftValue, data: { ...draftValue.data, redactSecrets: value } }))
                            }
                            label="Redact secrets in context"
                            description="Strip detected keys and tokens before a model call."
                          />
                          <Switch
                            checked={current().data.blockPiiExport}
                            disabled={!writable()}
                            onChange={(value) =>
                              update((draftValue) => ({ ...draftValue, data: { ...draftValue.data, blockPiiExport: value } }))
                            }
                            label="Block PII export"
                            description="Prevent personal data from leaving through tool output or exports."
                          />
                          <Switch
                            checked={current().data.encryptionAtRest}
                            disabled={!writable()}
                            onChange={(value) =>
                              update((draftValue) => ({
                                ...draftValue,
                                data: { ...draftValue.data, encryptionAtRest: value },
                              }))
                            }
                            label="Encryption at rest"
                            description="Recorded assertion for your storage layer. This server stores its own state as owner-only files."
                          />
                          <Switch
                            checked={current().data.byok}
                            disabled={!writable()}
                            onChange={(value) => update((draftValue) => ({ ...draftValue, data: { ...draftValue.data, byok: value } }))}
                            label="Bring your own key"
                            description="Require customer-managed model keys in client builds."
                          />
                        </div>
                      </div>
                    </Card>

                    <Card
                      title="Tool permissions"
                      description="Which capabilities an agent may exercise without asking. These are recorded as policy and published in the client manifest."
                    >
                      <div class="ent-toggle-grid">
                        <Switch
                          checked={current().tools.allowShell}
                          disabled={!writable()}
                          onChange={(value) => update((draftValue) => ({ ...draftValue, tools: { ...draftValue.tools, allowShell: value } }))}
                          label="Shell commands"
                          description="Run terminal commands on a paired computer."
                        />
                        <Switch
                          checked={current().tools.allowFileWrite}
                          disabled={!writable()}
                          onChange={(value) =>
                            update((draftValue) => ({ ...draftValue, tools: { ...draftValue.tools, allowFileWrite: value } }))
                          }
                          label="Write files"
                          description="Create or modify files in an approved workspace."
                        />
                        <Switch
                          checked={current().tools.allowNetwork}
                          disabled={!writable()}
                          onChange={(value) =>
                            update((draftValue) => ({ ...draftValue, tools: { ...draftValue.tools, allowNetwork: value } }))
                          }
                          label="Network access"
                          description="Reach the network from a tool call."
                        />
                        <Switch
                          checked={current().tools.allowComputerUse}
                          disabled={!writable()}
                          onChange={(value) =>
                            update((draftValue) => ({ ...draftValue, tools: { ...draftValue.tools, allowComputerUse: value } }))
                          }
                          label="Computer use"
                          description="Read the screen and control the desktop."
                        />
                        <Switch
                          checked={current().tools.allowBrowser}
                          disabled={!writable()}
                          onChange={(value) =>
                            update((draftValue) => ({ ...draftValue, tools: { ...draftValue.tools, allowBrowser: value } }))
                          }
                          label="Browser automation"
                          description="Drive a managed browser session."
                        />
                        <Switch
                          checked={current().tools.allowSecrets}
                          disabled={!writable()}
                          onChange={(value) =>
                            update((draftValue) => ({ ...draftValue, tools: { ...draftValue.tools, allowSecrets: value } }))
                          }
                          label="Credential vault"
                          description="Use stored service credentials during a task."
                        />
                      </div>
                      <div style={{ "margin-top": "12px" }}>
                        <Field
                          label="Always require approval for"
                          hint="Comma-separated tool names. Prompts for these are never auto-approved."
                        >
                          <Input
                            value={current().tools.requireApprovalFor.join(", ")}
                            disabled={!writable()}
                            placeholder="shell, credentials"
                            onInput={(value) =>
                              update((draftValue) => ({
                                ...draftValue,
                                tools: { ...draftValue.tools, requireApprovalFor: lines(value) },
                              }))
                            }
                          />
                        </Field>
                      </div>
                      <div style={{ "margin-top": "12px" }}>
                        <InlineNote icon="warning">
                          Stricter tool policy can block legitimate workflows. Test with a small group before applying
                          it to everyone.
                        </InlineNote>
                      </div>
                    </Card>                      </div>
                      <div class="ent-stack">
                    <Card title="Audit trail" description="How long security events are kept and where they are sent.">
                      <div class="ent-form-grid">
                        <Field label="Audit retention (days)" error={errors().auditRetention}>
                          <Input
                            type="number"
                            min={1}
                            max={3650}
                            value={current().audit.retentionDays}
                            disabled={!writable()}
                            onInput={(value) =>
                              update((draftValue) => ({
                                ...draftValue,
                                audit: { ...draftValue.audit, retentionDays: numberValue(value, 365) },
                              }))
                            }
                          />
                        </Field>
                        <Field label="Default export format">
                          <Select
                            value={current().audit.exportFormat}
                            disabled={!writable()}
                            onChange={(value) =>
                              update((draftValue) => ({ ...draftValue, audit: { ...draftValue.audit, exportFormat: value } }))
                            }
                            options={[
                              { value: "json", label: "JSON" },
                              { value: "csv", label: "CSV" },
                            ]}
                          />
                        </Field>
                        <Field
                          class="ent-span-2"
                          label="SIEM webhook"
                          hint="Optional. Where exported security events should be delivered."
                          error={errors().siem}
                        >
                          <Input
                            value={current().audit.siemWebhook ?? ""}
                            disabled={!writable()}
                            placeholder="https://siem.example.com/ingest/omnia"
                            onInput={(value) =>
                              update((draftValue) => ({
                                ...draftValue,
                                audit: { ...draftValue.audit, siemWebhook: value },
                              }))
                            }
                          />
                        </Field>
                      </div>
                      <div style={{ "margin-top": "12px" }}>
                        <InlineNote icon="review">
                          Audit records in this deployment are append-only and bounded by the retention setting. Every
                          change to this page is itself recorded.
                        </InlineNote>
                      </div>
                    </Card>

                    <Card title="Network" description="Recorded egress policy for client builds.">
                      <div class="ent-form-grid">
                        <div class="ent-span-2">
                          <Switch
                            checked={current().network.blockPublicEgress}
                            disabled={!writable()}
                            onChange={(value) =>
                              update((draftValue) => ({
                                ...draftValue,
                                network: { ...draftValue.network, blockPublicEgress: value },
                              }))
                            }
                            label="Block public egress"
                            description="Published to clients as a requirement. Your network controls remain the enforcement point."
                          />
                        </div>
                        <div class="ent-span-2">
                          <Field
                            label="Egress allowlist"
                            hint="One host per line. Empty means no extra restriction from this policy."
                          >
                            <Textarea
                              rows={4}
                              value={current().network.egressAllowlist.join("\n")}
                              disabled={!writable()}
                              placeholder={"api.openai.com\napi.anthropic.com\n*.company.internal"}
                              onInput={(value) =>
                                update((draftValue) => ({ ...draftValue, network: { ...draftValue.network, egressAllowlist: lines(value) } }))
                              }
                            />
                          </Field>
                        </div>
                      </div>
                    </Card>

                    </div>
                    </div>

                    <div class="ent-policy-foot">
                    <div class="ent-row ent-spread ent-small ent-faint">
                      <span>Changes are applied to the client manifest the next time a build is published.</span>
                      <Button variant="ghost" size="small" onClick={() => navigate("/distributions")}>
                        Review client builds
                      </Button>
                    </div>

                    <Show when={dirty()}>
                      <div class="ent-sticky-save">
                        <div>
                          <strong>Unsaved policy changes</strong>
                          <span class="ent-small ent-faint"> Applies to every build on the next publish.</span>
                        </div>
                        <div class="ent-row">
                          <Button variant="ghost" onClick={reset} disabled={saving()}>
                            Discard
                          </Button>
                          <Button variant="primary" icon="check" loading={saving()} onClick={() => void save()}>
                            Save policies
                          </Button>
                        </div>
                      </div>
                    </Show>
                    </div>
                  </div>
          )
        }}
      </Show>
    </div>
  )
}
