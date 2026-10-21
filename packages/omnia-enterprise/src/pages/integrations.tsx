import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import { api } from "@/lib/api"
import { dateTime, relative } from "@/lib/format"
import { href } from "@/lib/router"
import { useSession, useToast } from "@/state"
import {
  Button,
  Card,
  CopyField,
  EmptyState,
  Field,
  InlineNote,
  Input,
  Modal,
  PageHeader,
  SectionDivider,
  Skeleton,
  Switch,
  Tag,
} from "@/components/ui"
import type { Integrations } from "@/types"
import "./organization.css"

type UrlField = "slackWebhook" | "teamsWebhook" | "gchatWebhook" | "siemWebhook" | "genericWebhook"

// The console organization carries the presence of the hashed SCIM credential
// so the page can say whether a token was ever issued. It is never displayed.
type ConsoleOrganization = import("@/types").Organization & { scimTokenHash?: string }

const WEBHOOKS: {
  field: UrlField
  label: string
  placeholder: string
  hint: string
}[] = [
  {
    field: "slackWebhook",
    label: "Slack incoming webhook",
    placeholder: "https://hooks.slack.com/services/…",
    hint: "Channel where release, access and policy notices should be posted.",
  },
  {
    field: "teamsWebhook",
    label: "Microsoft Teams webhook",
    placeholder: "https://…webhook.office.com/…",
    hint: "Teams channel for the same operational notices.",
  },
  {
    field: "gchatWebhook",
    label: "Google Chat webhook",
    placeholder: "https://chat.googleapis.com/v1/spaces/…",
    hint: "Google Chat space for workspace administrators.",
  },
]

function blank(): Integrations {
  return {
    slackWebhook: "",
    teamsWebhook: "",
    gchatWebhook: "",
    siemWebhook: "",
    genericWebhook: "",
    scimEnabled: false,
  }
}

function httpsUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== "https:") return "Use an https:// URL."
    return undefined
  } catch {
    return "Enter a valid URL."
  }
}

export function IntegrationsPage() {
  const session = useSession()
  const toast = useToast()
  const [saved, { refetch }] = createResource(async () => (await api.integrations()).integrations)
  const [organization, { refetch: refetchOrganization }] = createResource(async () => (await api.organization()).organization)
  const [distributions] = createResource(async () => (await api.distributions()).distributions)
  const [draft, setDraft] = createSignal<Integrations | null>(null)
  // The last value the server acknowledged. Rotation updates the server side
  // without discarding webhook edits, so dirty compares against this rather
  // than against a possibly stale resource.
  const [baseline, setBaseline] = createSignal<Integrations | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [scim, setScim] = createSignal<{ token: string; baseUrl: string } | null>(null)
  const [rotating, setRotating] = createSignal(false)

  createEffect(() => {
    const value = saved()
    if (value !== undefined && baseline() === null) {
      const next = { ...blank(), ...value }
      setDraft(next)
      setBaseline(next)
    }
  })

  const value = () => draft()
  const canWrite = () => session.can("integrations:write")
  const canScim = () => session.can("scim:write")
  const scimEnabled = () => value()?.scimEnabled === true || organization()?.scimEnabled === true
  const scimIssued = () => {
    const org = organization() as ConsoleOrganization | undefined
    return org?.scimTokenHash !== undefined || scimEnabled()
  }

  const update = (patch: Partial<Integrations>) => {
    setDraft((current) => (current === null ? current : { ...current, ...patch }))
  }

  const dirty = createMemo(() => {
    const current = draft()
    const original = baseline()
    if (current === null || original === null) return false
    return JSON.stringify(current) !== JSON.stringify({ ...blank(), ...original })
  })

  const errors = createMemo(() => {
    const current = draft()
    const result: Partial<Record<UrlField, string>> = {}
    if (current === null) return result
    for (const field of [...WEBHOOKS.map((entry) => entry.field), "siemWebhook", "genericWebhook"] as UrlField[]) {
      const problem = httpsUrl(current[field])
      if (problem !== undefined) result[field] = problem
    }
    return result
  })

  const valid = createMemo(() => Object.keys(errors()).length === 0)

  const chatConfigured = createMemo(
    () =>
      [value()?.slackWebhook, value()?.teamsWebhook, value()?.gchatWebhook].filter(
        (entry) => entry !== undefined && entry.trim().length > 0,
      ).length,
  )

  const save = async () => {
    const current = draft()
    if (current === null || !valid()) return
    setSaving(true)
    setError(undefined)
    try {
      const result = await api.saveIntegrations({ ...blank(), ...current })
      const next = { ...blank(), ...result.integrations }
      setDraft(next)
      setBaseline(next)
      await refetch()
      await refetchOrganization()
      toast.push("Integrations saved.", "success")
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not save integrations."
      setError(message)
      toast.push(message, "error")
    } finally {
      setSaving(false)
    }
  }

  const rotateScim = async () => {
    setRotating(true)
    setError(undefined)
    try {
      const result = await api.rotateScimToken()
      setScim({ token: result.token, baseUrl: result.baseUrl })
      setDraft((current) => (current === null ? current : { ...current, scimEnabled: true }))
      setBaseline((current) => (current === null ? current : { ...current, scimEnabled: true }))
      await refetchOrganization()
      toast.push("A new SCIM bearer token was issued.", "success")
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not rotate the SCIM token."
      setError(message)
      toast.push(message, "error")
    } finally {
      setRotating(false)
    }
  }

  const scimBase = () => `${location.origin}/v1/enterprise/scim/v2`

  return (
    <div class="ent-page">
      <PageHeader
        kicker="Organization"
        title="Integrations"
        description="Connect the systems that provision people, receive security notices and archive the audit trail. Everything is configured on this server."
        actions={
          <>
            <Show when={saved()?.scimEnabled || scimEnabled()}>
              <Tag tone="success" dot>
                SCIM on
              </Tag>
            </Show>
            <Show when={canWrite()}>
              <Button variant="primary" loading={saving()} disabled={!dirty() || !valid()} onClick={() => void save()}>
                Save changes
              </Button>
            </Show>
          </>
        }
      />

      <Show when={error()}>
        <div style={{ "margin-bottom": "14px" }}>
          <InlineNote tone="danger" icon="warning">
            {error()}
          </InlineNote>
        </div>
      </Show>

      <Show when={saved.error}>
        <div style={{ "margin-bottom": "14px" }}>
          <InlineNote tone="danger" icon="warning">
            <div class="ent-spread">
              <span>
                {saved.error instanceof Error ? saved.error.message : "Integrations could not be loaded."}
              </span>
              <Button size="small" variant="secondary" onClick={() => void refetch()}>
                Retry
              </Button>
            </div>
          </InlineNote>
        </div>
      </Show>

      <Show
        when={draft()}
        fallback={
          <div class="ent-stack">
            <Card>
              <div class="ent-stack">
                <Skeleton height={16} width="30%" />
                <Skeleton height={32} />
                <Skeleton height={32} />
              </div>
            </Card>
            <Card>
              <Skeleton height={120} />
            </Card>
          </div>
        }
      >
        {(current) => (
          <div class="ent-split">
            <div class="ent-stack">
              <Card
                title="Identity provisioning"
                description="SCIM 2.0 lets your identity provider create, update and deactivate people here."
                actions={<Tag tone={scimEnabled() ? "success" : "muted"}>{scimEnabled() ? "Enabled" : "Off"}</Tag>}
              >
                <div class="ent-form-grid">
                  <Field
                    label="SCIM base URL"
                    hint="Point Okta, Entra ID, OneLogin or any SCIM 2.0 client at this address."
                    class="ent-span-2"
                  >
                    <CopyField value={scimBase()} />
                  </Field>
                </div>
                <div style={{ "margin-top": "8px" }}>
                  <Switch
                    checked={current().scimEnabled}
                    disabled={!canWrite()}
                    onChange={(checked) => update({ scimEnabled: checked })}
                    label="Accept SCIM requests"
                    description="When off, the bearer token is ignored. Existing people are not changed."
                  />
                </div>
                <div class="org-endpoint-actions">
                  <Button
                    variant="secondary"
                    icon="reset"
                    loading={rotating()}
                    disabled={!canScim()}
                    onClick={() => void rotateScim()}
                  >
                    {scimIssued() ? "Rotate bearer token" : "Issue bearer token"}
                  </Button>
                  <span class="ent-small ent-faint">
                    Users and Groups endpoints · bearer authentication · token shown once
                  </span>
                </div>
                <Show when={!canScim()}>
                  <div style={{ "margin-top": "10px" }}>
                    <InlineNote icon="shield">Your role can read integrations but cannot rotate SCIM credentials.</InlineNote>
                  </div>
                </Show>
                <div class="org-inline-code">
                  <div class="ent-label org-code-label">Endpoints</div>
                  <code>GET /Users · POST /Users · GET /Users/:id · PATCH /Users/:id · DELETE /Users/:id</code>
                  <br />
                  <code>GET /Groups · GET /ServiceProviderConfig</code>
                </div>
              </Card>

              <Card
                title="Chat notifications"
                description="Where notices for the administrators on call should be delivered."
                actions={<Tag tone={chatConfigured() > 0 ? "success" : "muted"}>{chatConfigured()} configured</Tag>}
              >
                <div class="ent-form-grid">
                  <For each={WEBHOOKS}>
                    {(entry) => (
                      <Field
                        label={entry.label}
                        hint={entry.hint}
                        error={errors()[entry.field]}
                        class={entry.field === "gchatWebhook" ? "ent-span-2" : undefined}
                      >
                        <Input
                          value={current()[entry.field] ?? ""}
                          onInput={(next) => update({ [entry.field]: next } as Partial<Integrations>)}
                          placeholder={entry.placeholder}
                          type="url"
                          disabled={!canWrite()}
                        />
                      </Field>
                    )}
                  </For>
                </div>
                <div style={{ "margin-top": "8px" }}>
                  <InlineNote icon="help">
                    These endpoints are stored on this server for your delivery service. The events it forwards are
                    the same ones in the audit log — invitations, sign-ins, releases and policy changes — never
                    prompts or screen contents.
                  </InlineNote>
                </div>
              </Card>

              <Card
                title="Security & compliance"
                description="Ship the audit trail to the system that already watches your estate."
              >
                <SectionDivider label="SIEM and event export" />
                <div class="ent-form-grid">
                  <Field
                    label="SIEM webhook"
                    hint="Target for your collector or a gateway in front of it. Audit records remain the source of truth."
                    error={errors().siemWebhook}
                  >
                    <Input
                      value={current().siemWebhook ?? ""}
                      onInput={(next) => update({ siemWebhook: next })}
                      placeholder="https://siem.internal/ingest/omnia"
                      type="url"
                      disabled={!canWrite()}
                    />
                  </Field>
                  <Field
                    label="Generic webhook"
                    hint="For ticketing, chat-ops or a small automation service."
                    error={errors().genericWebhook}
                  >
                    <Input
                      value={current().genericWebhook ?? ""}
                      onInput={(next) => update({ genericWebhook: next })}
                      placeholder="https://automation.internal/hooks/omnia"
                      type="url"
                      disabled={!canWrite()}
                    />
                  </Field>
                </div>
                <div class="ent-list" style={{ "margin-top": "10px" }}>
                  <div class="ent-list-row">
                    <span class="ent-list-row-main">
                      <span class="ent-list-row-title">Audit retention</span>
                      <span class="ent-list-row-sub">
                        Currently {session.session()!.organization.policies.audit.retentionDays} days ·{" "}
                        {session.session()!.organization.policies.audit.exportFormat.toUpperCase()} export
                      </span>
                    </span>
                    <a class="ent-button" data-variant="ghost" data-size="small" href={href("/policies")}>
                      Change
                    </a>
                  </div>
                  <div class="ent-list-row">
                    <span class="ent-list-row-main">
                      <span class="ent-list-row-title">Export the full trail</span>
                      <span class="ent-list-row-sub">CSV from the audit log, gated by the auditor capability</span>
                    </span>
                    <a class="ent-button" data-variant="ghost" data-size="small" href={href("/audit")}>
                      Audit log
                    </a>
                  </div>
                  <div class="ent-list-row">
                    <span class="ent-list-row-main">
                      <span class="ent-list-row-title">Data residency</span>
                      <span class="ent-list-row-sub">Self-hosted · records never leave this server</span>
                    </span>
                    <Tag tone="accent">this server</Tag>
                  </div>
                </div>
              </Card>

              <Show when={dirty()}>
                <div class="org-sticky-save">
                  <div class="ent-card">
                    <span class="ent-small">
                      {valid() ? "You have unsaved integration changes." : "Fix the highlighted URLs before saving."}
                    </span>
                    <span class="ent-topbar-spacer" />
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={!canWrite()}
                      onClick={() => {
                        const original = baseline()
                        if (original !== null) setDraft({ ...blank(), ...original })
                      }}
                    >
                      Discard
                    </Button>
                    <Button
                      size="small"
                      variant="primary"
                      loading={saving()}
                      disabled={!valid() || !canWrite()}
                      onClick={() => void save()}
                    >
                      Save changes
                    </Button>
                  </div>
                </div>
              </Show>
            </div>

            <div class="ent-stack org-rail">
              <Card
                title="Identity providers"
                description="Each client build carries its own sign-in methods."
                actions={
                  <Show when={session.can("distributions:read")}>
                    <a class="ent-button" data-variant="ghost" data-size="small" href={href("/distributions")}>
                      Builds
                    </a>
                  </Show>
                }
              >
                <Show
                  when={(distributions()?.length ?? 0) > 0}
                  fallback={
                    <EmptyState
                      compact
                      icon="shield"
                      title="No client builds yet"
                      description="Sign-in methods are set per build. Create one to configure OIDC or SAML."
                      action={
                        <a class="ent-button" data-variant="secondary" data-size="small" href={href("/distributions")}>
                          Client builds
                        </a>
                      }
                    />
                  }
                >
                  <div class="ent-list">
                    <For each={distributions()}>
                      {(distribution) => (
                        <a class="ent-list-row" href={href(`/distributions/${distribution.id}`)}>
                          <span class="ent-list-row-main">
                            <span class="ent-list-row-title">{distribution.name}</span>
                            <span class="ent-list-row-sub">
                              v{distribution.version} · {distribution.status}
                            </span>
                          </span>
                          <div class="ent-row" style={{ gap: "4px", "flex-wrap": "wrap", "justify-content": "flex-end" }}>
                            <For each={distribution.auth.methods}>
                              {(method) => <Tag tone={method === "password" ? "muted" : "accent"}>{method.toUpperCase()}</Tag>}
                            </For>
                          </div>
                        </a>
                      )}
                    </For>
                  </div>
                </Show>
                <div style={{ "margin-top": "10px" }}>
                  <InlineNote icon="help">
                    Every build is SSO-only: people sign in with a work email or employee ID. Social sign-in is not
                    available in an enterprise build.
                  </InlineNote>
                </div>
              </Card>

              <Card title="Provisioning checklist">
                <div class="ent-list">
                  <div class="ent-list-row">
                    <span class="ent-list-row-main">
                      <span class="ent-list-row-title">Create a SCIM token</span>
                      <span class="ent-list-row-sub">Shown once, stored hashed on this server</span>
                    </span>
                    <Tag tone={scimIssued() ? "success" : "warning"}>{scimIssued() ? "issued" : "pending"}</Tag>
                  </div>
                  <div class="ent-list-row">
                    <span class="ent-list-row-main">
                      <span class="ent-list-row-title">Enable the endpoint</span>
                      <span class="ent-list-row-sub">Accepts SCIM Users and Groups</span>
                    </span>
                    <Tag tone={current().scimEnabled ? "success" : "muted"}>
                      {current().scimEnabled ? "on" : "off"}
                    </Tag>
                  </div>
                  <div class="ent-list-row">
                    <span class="ent-list-row-main">
                      <span class="ent-list-row-title">Review group membership</span>
                      <span class="ent-list-row-sub">SCIM provisions people; assign Omnia groups here</span>
                    </span>
                    <a class="ent-button" data-variant="ghost" data-size="small" href={href("/groups")}>
                      Groups
                    </a>
                  </div>
                  <div class="ent-list-row">
                    <span class="ent-list-row-main">
                      <span class="ent-list-row-title">Review the audit trail</span>
                      <span class="ent-list-row-sub">Every SCIM change is recorded</span>
                    </span>
                    <a class="ent-button" data-variant="ghost" data-size="small" href={href("/audit")}>
                      Open
                    </a>
                  </div>
                </div>
              </Card>

              <Card title="Connection details" description="For the administrator configuring the other side.">
                <div class="ent-list">
                  <div class="ent-list-row">
                    <span class="ent-list-row-main">
                      <span class="ent-list-row-title">Server origin</span>
                      <span class="ent-list-row-sub">Same origin as this console</span>
                    </span>
                    <span class="ent-list-row-meta">{location.host}</span>
                  </div>
                  <div class="ent-list-row">
                    <span class="ent-list-row-main">
                      <span class="ent-list-row-title">SCIM version</span>
                      <span class="ent-list-row-sub">ServiceProviderConfig advertises filter and patch support</span>
                    </span>
                    <Tag tone="muted">2.0</Tag>
                  </div>
                  <div class="ent-list-row">
                    <span class="ent-list-row-main">
                      <span class="ent-list-row-title">Last organization change</span>
                      <span class="ent-list-row-sub">
                        {organization() === undefined ? "—" : relative(organization()!.updatedAt)}
                      </span>
                    </span>
                    <span class="ent-list-row-meta">
                      {organization() === undefined ? "" : dateTime(organization()!.updatedAt)}
                    </span>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        )}
      </Show>

      <Modal
        open={scim() !== null}
        onClose={() => setScim(null)}
        title="SCIM bearer token"
        description="This is the only time the token is shown. Store it in your identity provider now."
        footer={<Button variant="primary" onClick={() => setScim(null)}>Done</Button>}
      >
        <Show when={scim()}>
          {(details) => (
            <>
              <Field label="Base URL">
                <CopyField value={details().baseUrl} />
              </Field>
              <Field label="Bearer token" hint="Send it as `Authorization: Bearer …`. Rotating replaces it immediately.">
                <CopyField value={details().token} />
              </Field>
              <InlineNote tone="warning" icon="warning">
                Treat this value like a password. Omnia stores only a hash; it cannot show it again.
              </InlineNote>
            </>
          )}
        </Show>
      </Modal>
    </div>
  )
}

