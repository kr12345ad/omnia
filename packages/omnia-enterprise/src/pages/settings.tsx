import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { api } from "@/lib/api"
import { date, dateTime, number, plural, until } from "@/lib/format"
import { href } from "@/lib/router"
import { useSession, useToast } from "@/state"
import {
  Button,
  Card,
  CopyField,
  Definition,
  Field,
  InlineNote,
  Input,
  PageHeader,
  Select,
  Switch,
  Tabs,
  Tag,
  Textarea,
} from "@/components/ui"
import type { Branding, Capability, Organization } from "@/types"
import "./organization.css"

type SettingsTab = "organization" | "branding" | "license" | "access"

const REGIONS = [
  { value: "self-hosted", label: "Self-hosted" },
  { value: "us", label: "United States" },
  { value: "eu", label: "European Union" },
  { value: "apac", label: "Asia Pacific" },
]

const LICENSE_PREFIX = "omnia_lic_"

function planTone(plan: string): "success" | "warning" | "danger" | "accent" {
  if (plan === "trial") return "warning"
  if (plan === "expired") return "danger"
  if (plan === "enterprise") return "accent"
  return "success"
}

export function SettingsPage() {
  const session = useSession()
  const toast = useToast()
  const [tab, setTab] = createSignal<SettingsTab>("organization")
  const [org, { refetch: refetchOrg }] = createResource(async () => (await api.organization()).organization)
  const [license, { refetch: refetchLicense }] = createResource(() => api.license())

  const [profile, setProfile] = createSignal({
    name: "",
    supportEmail: "",
    website: "",
    logoUrl: "",
    region: "self-hosted",
  })
  const [branding, setBranding] = createSignal<Branding | undefined>()
  const [savingProfile, setSavingProfile] = createSignal(false)
  const [savingBranding, setSavingBranding] = createSignal(false)
  const [formError, setFormError] = createSignal<string>()

  createEffect(() => {
    const value = org()
    if (value === undefined) return
    setProfile({
      name: value.name,
      supportEmail: value.supportEmail ?? "",
      website: value.website ?? "",
      logoUrl: value.logoUrl ?? "",
      region: value.region,
    })
    setBranding({ ...value.branding })
  })

  const profileDirty = createMemo(() => {
    const value = org()
    if (value === undefined) return false
    return (
      profile().name !== value.name ||
      profile().supportEmail !== (value.supportEmail ?? "") ||
      profile().website !== (value.website ?? "") ||
      profile().logoUrl !== (value.logoUrl ?? "") ||
      profile().region !== value.region
    )
  })

  const brandingDirty = createMemo(() => {
    const value = org()
    if (value === undefined || branding() === undefined) return false
    return JSON.stringify(branding()) !== JSON.stringify(value.branding)
  })

  const setBrandingField = <K extends keyof Branding>(key: K, value: Branding[K]) => {
    setBranding((current) => (current === undefined ? current : ({ ...current, [key]: value } as Branding)))
  }

  const saveProfile = async () => {
    setSavingProfile(true)
    setFormError(undefined)
    try {
      const result = await api.updateOrganization({
        name: profile().name,
        supportEmail: profile().supportEmail,
        website: profile().website,
        logoUrl: profile().logoUrl,
        region: profile().region,
      })
      setProfile({
        name: result.organization.name,
        supportEmail: result.organization.supportEmail ?? "",
        website: result.organization.website ?? "",
        logoUrl: result.organization.logoUrl ?? "",
        region: result.organization.region,
      })
      await session.refresh()
      void refetchOrg()
      toast.push("Organization settings saved.", "success")
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not save the organization.")
    } finally {
      setSavingProfile(false)
    }
  }

  const saveBranding = async () => {
    const draft = branding()
    if (draft === undefined) return
    setSavingBranding(true)
    setFormError(undefined)
    try {
      const result = await api.updateOrganization({ branding: draft })
      setBranding({ ...result.organization.branding })
      await session.refresh()
      void refetchOrg()
      toast.push("Default branding saved.", "success")
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not save the branding.")
    } finally {
      setSavingBranding(false)
    }
  }

  const canWrite = () => session.can("org:write")
  const licensePlan = () => license()?.license.plan ?? session.session()!.organization.plan
  const seats = () => license()?.license.seats
  const trialDays = () => Math.max(0, Math.ceil((session.session()!.organization.trialEndsAt - Date.now()) / 86_400_000))

  const capabilitiesByGroup = createMemo(() => {
    const grouped = new Map<string, Capability[]>()
    for (const capability of session.session()!.capabilities) {
      const prefix = capability.split(":")[0] ?? "other"
      const list = grouped.get(prefix) ?? []
      list.push(capability)
      grouped.set(prefix, list)
    }
    return [...grouped.entries()]
  })

  return (
    <div class="ent-page">
      <PageHeader
        kicker="Organization"
        title="Settings"
        description="The identity, defaults and license behind this deployment. Client builds can override branding and policy without changing anything here."
        actions={
          <>
            <Tag tone={planTone(licensePlan())}>{licensePlan() === "trial" ? `Trial · ${trialDays()}d` : licensePlan()}</Tag>
            <Button variant="secondary" icon="server" onClick={() => window.open(`${window.location.origin}/v1/enterprise/public/health`, "_blank")}>
              Health
            </Button>
          </>
        }
      />

      <Tabs
        tabs={[
          { id: "organization", label: "Organization" },
          { id: "branding", label: "Branding" },
          { id: "license", label: "License" },
          { id: "access", label: "Access" },
        ]}
        active={tab()}
        onChange={(id) => setTab(id)}
      />

      <Show when={formError()}>
        <div style={{ "margin-top": "14px" }}>
          <InlineNote tone="danger" icon="warning">
            {formError()}
          </InlineNote>
        </div>
      </Show>

      <Show when={tab() === "organization"}>
        <div class="ent-split" style={{ "margin-top": "16px" }}>
          <div class="ent-stack">
          <Card
            title="Organization profile"
            description="Used in the console, enrollment pages and as the default for new client builds."
            actions={
              <Button
                variant="primary"
                loading={savingProfile()}
                disabled={!canWrite() || !profileDirty()}
                onClick={() => void saveProfile()}
              >
                Save changes
              </Button>
            }
          >
            <Show when={org() !== undefined} fallback={<div class="ent-skeleton" style={{ height: "180px" }} />}>
              <div class="ent-form-grid">
                <Field label="Organization name" required>
                  <Input value={profile().name} onInput={(value) => setProfile({ ...profile(), name: value })} />
                </Field>
                <Field label="Region">
                  <Select
                    value={profile().region}
                    onChange={(value) => setProfile({ ...profile(), region: value })}
                    options={REGIONS}
                  />
                </Field>
                <Field label="Support email" hint="Shown to people when they need help with access.">
                  <Input
                    value={profile().supportEmail}
                    onInput={(value) => setProfile({ ...profile(), supportEmail: value })}
                    placeholder="support@company.com"
                    type="email"
                  />
                </Field>
                <Field label="Website">
                  <Input
                    value={profile().website}
                    onInput={(value) => setProfile({ ...profile(), website: value })}
                    placeholder="https://company.com"
                    type="url"
                  />
                </Field>
                <Field label="Organization logo URL" class="ent-span-2" hint="Used on the sign-in page. Client builds can set their own.">
                  <Input
                    value={profile().logoUrl}
                    onInput={(value) => setProfile({ ...profile(), logoUrl: value })}
                    placeholder="https://company.com/logo.svg"
                    type="url"
                  />
                </Field>
              </div>
              <Show when={!canWrite()}>
                <InlineNote icon="shield">
                  Your role can view settings but not change them.
                </InlineNote>
              </Show>
              <Show when={profileDirty()}>
                <div class="ent-small ent-faint">
                  Unsaved changes. The organization name updates default branding only; published builds keep
                  their own name.
                </div>
              </Show>
            </Show>
          </Card>

          <Show when={org() !== undefined}>
            <Card title="Deployment" description="Where this console runs and how it is backed up.">
              <div class="ent-grid ent-grid-2 org-deployment-meta">
                <div>
                  <div class="ent-label">Console</div>
                  <div class="ent-mono ent-small org-break">{window.location.origin}/admin</div>
                </div>
                <div>
                  <div class="ent-label">API</div>
                  <div class="ent-mono ent-small org-break">{window.location.origin}/v1/enterprise</div>
                </div>
                <div>
                  <div class="ent-label">Region</div>
                  <div class="ent-small">{org()!.region}</div>
                </div>
              </div>
              <div class="ent-row org-section-gap">
                <a class="ent-button" data-variant="secondary" data-size="small" href={href("/deployment")}>
                  <Icon name="server" size="small" />
                  <span>Deployment guide</span>
                </a>
              </div>
            </Card>
          </Show>
          </div>

          <div class="ent-stack org-rail">
            <Card title="Identity" description="Immutable identifiers for this deployment.">
              <Show when={org()} fallback={<div class="ent-skeleton" style={{ height: "120px" }} />}>
                {(value) => (
                  <>
                    <Definition label="Organization ID">
                      <span class="ent-mono">{value().id}</span>
                    </Definition>
                    <Definition label="Console slug">
                      <span class="ent-mono">{value().slug}</span>
                    </Definition>
                    <Definition label="Owner email">{value().adminEmail}</Definition>
                    <Definition label="Created">{date(value().createdAt)}</Definition>
                    <Definition label="Last updated">{dateTime(value().updatedAt)}</Definition>
                  </>
                )}
              </Show>
            </Card>
            <Card title="Where this is used">
              <div class="ent-list">
                <a class="ent-list-row" href={href("/distributions")}>
                  <span class="ent-auth-point-icon">
                    <Icon name="download" size="small" />
                  </span>
                  <span class="ent-list-row-main">
                    <span class="ent-list-row-title">Client builds</span>
                    <span class="ent-list-row-sub">Branding, SSO and limits per build</span>
                  </span>
                  <Icon name="chevron-right" size="small" />
                </a>
                <a class="ent-list-row" href={href("/policies")}>
                  <span class="ent-auth-point-icon">
                    <Icon name="shield" size="small" />
                  </span>
                  <span class="ent-list-row-main">
                    <span class="ent-list-row-title">Policies</span>
                    <span class="ent-list-row-sub">Sessions, models, tools and data</span>
                  </span>
                  <Icon name="chevron-right" size="small" />
                </a>
                <a class="ent-list-row" href={href("/users")}>
                  <span class="ent-auth-point-icon">
                    <Icon name="users" size="small" />
                  </span>
                  <span class="ent-list-row-main">
                    <span class="ent-list-row-title">People</span>
                    <span class="ent-list-row-sub">Seats, roles and invitations</span>
                  </span>
                  <Icon name="chevron-right" size="small" />
                </a>
              </div>
            </Card>
          </div>
        </div>
      </Show>

      <Show when={tab() === "branding"}>
        <div style={{ "margin-top": "16px" }}>
          <Card
            title="Default branding"
            description="New client builds start from these values. Each build can override every field."
            actions={
              <div class="ent-row">
                <Button
                  variant="ghost"
                  disabled={!brandingDirty() || branding() === undefined}
                  onClick={() => {
                    const value = org()
                    if (value !== undefined) setBranding({ ...value.branding })
                  }}
                >
                  Reset
                </Button>
                <Button
                  variant="primary"
                  loading={savingBranding()}
                  disabled={!canWrite() || !brandingDirty()}
                  onClick={() => void saveBranding()}
                >
                  Save branding
                </Button>
              </div>
            }
          >
            <Show when={branding()} fallback={<div class="ent-skeleton" style={{ height: "220px" }} />}>
              {(draft) => (
                <>
                  <div class="ent-form-grid">
                    <Field label="Product name" hint="The name people see inside the client.">
                      <Input
                        value={draft().productName}
                        onInput={(value) => setBrandingField("productName", value)}
                      />
                    </Field>
                    <Field label="Short name" hint="Used where space is tight, such as the window title.">
                      <Input value={draft().shortName} onInput={(value) => setBrandingField("shortName", value)} />
                    </Field>
                    <Field label="Tagline" class="ent-span-2">
                      <Input value={draft().tagline} onInput={(value) => setBrandingField("tagline", value)} />
                    </Field>
                    <Field label="Primary color" hint="Buttons, active states and the wordmark.">
                      <div class="ent-row">
                        <input
                          type="color"
                          aria-label="Primary color"
                          value={draft().primaryColor}
                          onInput={(event) => setBrandingField("primaryColor", event.currentTarget.value)}
                          style={{ width: "34px", height: "32px", padding: "2px", border: "1px solid var(--ent-border-strong)", "border-radius": "6px", background: "var(--ent-panel)" }}
                        />
                        <Input
                          value={draft().primaryColor}
                          onInput={(value) => setBrandingField("primaryColor", value)}
                        />
                      </div>
                    </Field>
                    <Field label="Accent color" hint="Links, charts and focus rings.">
                      <div class="ent-row">
                        <input
                          type="color"
                          aria-label="Accent color"
                          value={draft().accentColor}
                          onInput={(event) => setBrandingField("accentColor", event.currentTarget.value)}
                          style={{ width: "34px", height: "32px", padding: "2px", border: "1px solid var(--ent-border-strong)", "border-radius": "6px", background: "var(--ent-panel)" }}
                        />
                        <Input
                          value={draft().accentColor}
                          onInput={(value) => setBrandingField("accentColor", value)}
                        />
                      </div>
                    </Field>
                    <Field label="Sign-in headline" class="ent-span-2">
                      <Input
                        value={draft().signInHeadline}
                        onInput={(value) => setBrandingField("signInHeadline", value)}
                      />
                    </Field>
                    <Field label="Sign-in subheadline" class="ent-span-2">
                      <Input
                        value={draft().signInSubheadline}
                        onInput={(value) => setBrandingField("signInSubheadline", value)}
                      />
                    </Field>
                    <Field label="Logo URL">
                      <Input
                        value={draft().logoUrl ?? ""}
                        onInput={(value) => setBrandingField("logoUrl", value)}
                        placeholder="https://company.com/logo.svg"
                        type="url"
                      />
                    </Field>
                    <Field label="Icon URL">
                      <Input
                        value={draft().iconUrl ?? ""}
                        onInput={(value) => setBrandingField("iconUrl", value)}
                        placeholder="https://company.com/icon.png"
                        type="url"
                      />
                    </Field>
                    <Field label="Support URL">
                      <Input
                        value={draft().supportUrl ?? ""}
                        onInput={(value) => setBrandingField("supportUrl", value)}
                        type="url"
                      />
                    </Field>
                    <Field label="Documentation URL">
                      <Input
                        value={draft().docsUrl ?? ""}
                        onInput={(value) => setBrandingField("docsUrl", value)}
                        type="url"
                      />
                    </Field>
                    <Field label="Footer text" class="ent-span-2">
                      <Input
                        value={draft().footerText ?? ""}
                        onInput={(value) => setBrandingField("footerText", value)}
                        placeholder="© 2026 Company. All rights reserved."
                      />
                    </Field>
                  </div>
                  <div style={{ "margin-top": "14px" }}>
                    <Switch
                      checked={draft().showOmniaBranding}
                      onChange={(value) => setBrandingField("showOmniaBranding", value)}
                      label="Show Omnia branding"
                      description="Turn off only if your agreement includes white-label distribution."
                    />
                  </div>
                  <InlineNote icon="download">
                    These values seed new builds. To change a shipped client, edit its build under{" "}
                    <a href={href("/distributions")}><strong>Client builds</strong></a>.
                  </InlineNote>
                </>
              )}
            </Show>
          </Card>
        </div>
      </Show>

      <Show when={tab() === "license"}>
        <div class="ent-split" style={{ "margin-top": "16px" }}>
          <div class="ent-stack">
            <Card
              title="Current license"
              description="Licenses verify offline with an Ed25519 public key. No phone-home."
              actions={<Tag tone={planTone(licensePlan())}>{licensePlan()}</Tag>}
            >
              <Show when={license()} fallback={<div class="ent-skeleton" style={{ height: "170px" }} />}>
                {(value) => (
                  <>
                    <div class="ent-grid ent-grid-3" style={{ "margin-bottom": "10px" }}>
                      <div>
                        <div class="ent-label">Plan</div>
                        <div style={{ "font-size": "17px", "font-weight": "600" }}>{value().license.plan}</div>
                      </div>
                      <div>
                        <div class="ent-label">Seats</div>
                        <div style={{ "font-size": "17px", "font-weight": "600" }}>
                          {number(value().license.seats.used)} / {number(value().license.seats.licensed)}
                        </div>
                      </div>
                      <div>
                        <div class="ent-label">Trial ends</div>
                        <div style={{ "font-size": "13px", "font-weight": "500", "margin-top": "4px" }}>
                          {date(value().license.trialEndsAt)}
                        </div>
                      </div>
                    </div>
                    <Show when={value().license.license.claims}>
                      {(claimsValue) => (
                        <>
                          <Definition label="License ID">
                            <span class="ent-mono">{claimsValue().id}</span>
                          </Definition>
                          <Definition label="Licensed to">{claimsValue().org}</Definition>
                          <Definition label="Plan">{claimsValue().plan}</Definition>
                          <Definition label="Seats">{number(claimsValue().seats)}</Definition>
                          <Definition label="Issued">{date(claimsValue().issuedAt)}</Definition>
                          <Definition label="Expires">{date(claimsValue().expiresAt)}</Definition>
                          <Show when={(claimsValue().features ?? []).length > 0}>
                            <Definition label="Features">
                              <span class="ent-row ent-wrap" style={{ "justify-content": "flex-end" }}>
                                <For each={claimsValue().features ?? []}>
                                  {(feature) => <Tag tone="muted">{feature}</Tag>}
                                </For>
                              </span>
                            </Definition>
                          </Show>
                        </>
                      )}
                    </Show>
                    <Show when={value().license.license.error}>
                      <InlineNote tone="danger" icon="warning">
                        {value().license.license.error}
                      </InlineNote>
                    </Show>
                    <Show when={!value().license.publicKeyConfigured}>
                      <InlineNote tone="warning" icon="warning">
                        No license public key is configured. Set{" "}
                        <code>OMNIA_ENTERPRISE_LICENSE_PUBLIC_KEY</code> or restart with{" "}
                        <code>--license-public-key</code> before activating a license.
                      </InlineNote>
                    </Show>
                  </>
                )}
              </Show>
            </Card>

            <Card
              title="Activate a license"
              description="Paste the signed token from your license file. The server verifies it before storing it."
            >
              <Show when={session.can("license:write")} fallback={<InlineNote icon="shield">Your role can view the license but not change it.</InlineNote>}>
                <LicenseActivation
                  onActivated={async () => {
                    await session.refresh()
                    void refetchLicense()
                    void refetchOrg()
                    toast.push("License activated.", "success")
                  }}
                />
              </Show>
            </Card>
          </div>

          <div class="ent-stack org-rail">
            <Card title="CLI" description="For air-gapped installs, the same operations on the server.">
              <div class="ent-stack">
                <CopyField value="omnia-server license inspect ./omnia.license" />
                <CopyField value="omnia-server license activate ./omnia.license" />
                <CopyField value="omnia-server doctor" />
              </div>
              <InlineNote icon="terminal">
                Activation writes the token to the deployment config and records an audit event. Restart the
                server if you changed the public key.
              </InlineNote>
            </Card>
            <Card title="Seat accounting">
              <Show when={seats()} fallback={<div class="ent-skeleton" style={{ height: "90px" }} />}>
                {(seatValue) => (
                  <>
                    <Definition label="Assigned seats">{number(seatValue().used)}</Definition>
                    <Definition label="Licensed seats">{number(seatValue().licensed)}</Definition>
                    <Definition label="Available">
                      {seatValue().available === null ? "No hard cap" : number(seatValue().available ?? 0)}
                    </Definition>
                    <InlineNote icon="subagent">
                      Suspended people do not hold a seat. Invitations reserve one when accepted.
                    </InlineNote>
                  </>
                )}
              </Show>
            </Card>
          </div>
        </div>
      </Show>

      <Show when={tab() === "access"}>
        <div class="ent-split" style={{ "margin-top": "16px" }}>
          <Card title="Your role" description="What this account can do in the console.">
            <div class="ent-spread" style={{ "margin-bottom": "10px" }}>
              <div class="ent-row">
                <span class="ent-avatar">{session.session()!.user.name.slice(0, 2).toUpperCase()}</span>
                <div>
                  <div style={{ "font-weight": "600" }}>{session.session()!.user.name}</div>
                  <div class="ent-small ent-faint">{session.session()!.user.email}</div>
                </div>
              </div>
              <Tag tone="accent">{session.session()!.user.role}</Tag>
            </div>
            <p class="ent-small ent-muted" style={{ margin: "0 0 12px" }}>
              {session.session()!.user.role === "owner"
                ? "Full control, including ownership, licensing and security."
                : session.session()!.user.role === "admin"
                  ? "Manages people, distributions, policies and integrations."
                  : session.session()!.user.role === "manager"
                    ? "Invites and manages team members, groups and usage reports."
                    : session.session()!.user.role === "auditor"
                      ? "Read-only access to the console, audit trail and reports."
                      : session.session()!.user.role === "billing"
                        ? "Sees usage and manages the license. No people or policy changes."
                        : "Uses the client. No console administration."}
            </p>
            <Definition label="Session expires">{until(session.session()!.session.expiresAt)}</Definition>
            <Definition label="Capabilities">{plural(session.session()!.capabilities.length, "permission")}</Definition>
            <Show when={session.can("org:security")}>
              <div style={{ "margin-top": "12px" }}>
                <InlineNote tone="warning" icon="shield">
                  You can change security policy. Review session length, IP allowlists and MFA requirements in{" "}
                  <a href={href("/policies")}><strong>Policies</strong></a>.
                </InlineNote>
              </div>
            </Show>
          </Card>

          <Card title="Capabilities" description="Granted by your role on this deployment.">
            <div class="ent-stack">
              <For each={capabilitiesByGroup()}>
                {([group, list]) => (
                  <div>
                    <div class="ent-label" style={{ "margin-bottom": "5px" }}>
                      {group}
                    </div>
                    <div class="ent-row ent-wrap" style={{ gap: "4px" }}>
                      <For each={list}>{(capability) => <Tag tone="muted">{capability}</Tag>}</For>
                    </div>
                  </div>
                )}
              </For>
            </div>
            <div class="ent-row ent-wrap" style={{ "margin-top": "14px" }}>
              <a class="ent-button" data-variant="secondary" data-size="small" href={href("/users")}>
                <Icon name="users" size="small" />
                <span>People</span>
              </a>
              <a class="ent-button" data-variant="secondary" data-size="small" href={href("/policies")}>
                <Icon name="shield" size="small" />
                <span>Policies</span>
              </a>
            </div>
          </Card>
        </div>
      </Show>

    </div>
  )
}

function LicenseActivation(props: { onActivated: () => Promise<void> }) {
  const [token, setToken] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const activate = async () => {
    const value = token().trim()
    if (value.length === 0) {
      setError("Paste the signed license token first.")
      return
    }
    if (!value.startsWith(LICENSE_PREFIX)) {
      setError(`An Omnia license starts with ${LICENSE_PREFIX}.`)
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.activateLicense(value)
      if (!result.ok) {
        setError(result.error ?? "The license was rejected.")
        return
      }
      setToken("")
      await props.onActivated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The license was rejected.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="ent-stack">
      <Field label="Signed license token" hint="A single line starting with omnia_lic_. It is stored in the deployment state.">
        <Textarea
          value={token()}
          onInput={(value) => {
            setToken(value)
            setError(undefined)
          }}
          rows={5}
          placeholder="omnia_lic_eyJ2ZXJzaW9uIjoxLC..."
          spellcheck={false}
        />
      </Field>
      <Show when={error()}>
        <InlineNote tone="danger" icon="warning">
          {error()}
        </InlineNote>
      </Show>
      <div class="ent-row">
        <Button variant="primary" loading={busy()} onClick={() => void activate()}>
          Verify and activate
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setToken("")
            setError(undefined)
          }}
        >
          Clear
        </Button>
      </div>
    </div>
  )
}
