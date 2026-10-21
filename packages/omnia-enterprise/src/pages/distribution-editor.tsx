import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { api } from "@/lib/api"
import { number, date, relative } from "@/lib/format"
import { navigate, routeSegments } from "@/lib/router"
import { useSession, useToast } from "@/state"
import {
  Button,
  Card,
  Checkbox,
  CopyField,
  Definition,
  EmptyState,
  Field,
  InlineNote,
  Input,
  Modal,
  PageHeader,
  SectionDivider,
  Select,
  Skeleton,
  Switch,
  Tabs,
  Tag,
  Textarea,
} from "@/components/ui"
import type {
  Branding,
  ClientAuth,
  ClientExperience,
  ClientFeatures,
  ClientLimits,
  ClientPermissions,
  ClientRelease,
  Distribution,
  ModelAccess,
  NetworkMode,
  PermissionMode,
  Platform,
} from "@/types"
import "./distributions.css"

type Tab = "branding" | "auth" | "features" | "experience" | "limits" | "models" | "telemetry" | "updates" | "platforms" | "release"

const TABS: { id: Tab; label: string }[] = [
  { id: "branding", label: "Branding" },
  { id: "auth", label: "Authentication" },
  { id: "features", label: "Features" },
  { id: "experience", label: "Experience" },
  { id: "limits", label: "Limits" },
  { id: "models", label: "Models" },
  { id: "telemetry", label: "Telemetry" },
  { id: "updates", label: "Updates" },
  { id: "platforms", label: "Platforms" },
  { id: "release", label: "Release" },
]

const FEATURES: { key: Exclude<keyof ClientFeatures, "telemetry">; label: string; description: string }[] = [
  { key: "computerUse", label: "Computer use", description: "Let the agent see and operate the desktop." },
  { key: "browserAutomation", label: "Browser automation", description: "Drive a managed browser for research and workflows." },
  { key: "cloudVision", label: "Cloud vision", description: "Send screenshots to a vision model for interpretation." },
  { key: "liveView", label: "Live view", description: "Watch a computer session while the agent works." },
  { key: "scheduledRuns", label: "Scheduled runs", description: "Fire unattended prompts on a fixed cadence." },
  { key: "chatChannels", label: "Chat channels", description: "Answer in Slack, Teams, Discord and Google Chat." },
  { key: "memory", label: "Memory", description: "Persist durable facts across sessions." },
  { key: "superskills", label: "Superskills", description: "Run approved local scripts as reusable tools." },
  { key: "subagents", label: "Subagents", description: "Spawn parallel workers for long tasks." },
  { key: "mcpMarketplace", label: "MCP marketplace", description: "Install Model Context Protocol servers." },
  { key: "fileAttachments", label: "File attachments", description: "Attach documents and images to a prompt." },
  { key: "shellTool", label: "Shell tool", description: "Run commands in the project workspace." },
  { key: "networkAccess", label: "Network access", description: "Allow the agent to reach the network." },
  { key: "credentialVault", label: "Credential vault", description: "Use stored sign-ins instead of pasting secrets." },
]

const PERMISSIONS: { key: keyof ClientPermissions; label: string; description: string }[] = [
  { key: "read", label: "Read files", description: "Read files inside the workspace." },
  { key: "edit", label: "Write files", description: "Create, edit, patch, or delete files." },
  { key: "bash", label: "Shell commands", description: "Run commands in the project workspace." },
  { key: "task", label: "Subagents", description: "Delegate work to parallel agents." },
  { key: "network", label: "Web access", description: "Fetch pages and search the web." },
  { key: "externalDirectory", label: "Outside the workspace", description: "Touch paths outside the project." },
  { key: "skill", label: "Skills", description: "Load and use installed skills." },
  { key: "computer", label: "Desktop control", description: "See and operate the desktop." },
]

/** The tool a capability switch owns; turning it off blocks that tool. */
const FEATURE_PERMISSION: Partial<Record<keyof ClientFeatures, keyof ClientPermissions>> = {
  shellTool: "bash",
  subagents: "task",
  networkAccess: "network",
  computerUse: "computer",
}

const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask first" },
  { value: "deny", label: "Block" },
]

/** Presets write every rule at once so an operator can start from a posture. */
const PERMISSION_PRESETS: { id: string; label: string; description: string; values: ClientPermissions }[] = [
  {
    id: "open",
    label: "Allow everything",
    description: "No approval prompts; every tool the build ships.",
    values: {
      read: "allow",
      edit: "allow",
      bash: "allow",
      task: "allow",
      network: "allow",
      externalDirectory: "allow",
      skill: "allow",
      computer: "allow",
    },
  },
  {
    id: "guarded",
    label: "Ask for risky tools",
    description: "Writes, shell, subagents and desktop control need approval.",
    values: {
      read: "allow",
      edit: "ask",
      bash: "ask",
      task: "ask",
      network: "allow",
      externalDirectory: "ask",
      skill: "allow",
      computer: "ask",
    },
  },
  {
    id: "read-only",
    label: "Read only",
    description: "Research and answer, but never change the machine.",
    values: {
      read: "allow",
      edit: "deny",
      bash: "deny",
      task: "deny",
      network: "allow",
      externalDirectory: "deny",
      skill: "allow",
      computer: "deny",
    },
  },
]

const LIMITS: { key: keyof ClientLimits; label: string; hint: string; step?: number }[] = [
  { key: "monthlyTokensPerUser", label: "Tokens / person / month", hint: "0 means no token ceiling." },
  { key: "monthlySpendPerUserUsd", label: "Spend / person / month", hint: "USD. 0 means no dollar ceiling.", step: 0.01 },
  { key: "maxComputersPerUser", label: "Computers / person", hint: "Paired devices and remote runtimes." },
  { key: "maxConcurrentSessions", label: "Concurrent sessions", hint: "Open turns at once per person." },
  { key: "contextWindowTokens", label: "Context window", hint: "Maximum prompt context the client requests." },
  { key: "dailyScheduledRuns", label: "Scheduled runs / day", hint: "0 disables unattended runs for this build." },
  { key: "storageGb", label: "Storage (GB)", hint: "Workspace and memory storage ceiling." },
  { key: "maxFileUploadMb", label: "Upload size (MB)", hint: "0 means unlimited." },
]

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "macos-arm64", label: "macOS · Apple silicon" },
  { id: "macos-x64", label: "macOS · Intel" },
  { id: "windows-x64", label: "Windows · x64" },
  { id: "linux-x64", label: "Linux · x64" },
  { id: "linux-arm64", label: "Linux · arm64" },
]



function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function nextVersion(version: string, alreadyPublished: boolean): string {
  const parts = version.split(".")
  if (parts.length !== 3) return "1.0.1"
  const major = Number.parseInt(parts[0] ?? "1", 10) || 1
  const minor = Number.parseInt(parts[1] ?? "0", 10) || 0
  const patch = Number.parseInt(parts[2] ?? "0", 10) || 0
  return alreadyPublished ? `${major}.${minor}.${patch + 1}` : `${major}.${minor}.${patch}`
}

function origin(): string {
  return location.origin
}

function manifestUrl(slug: string): string {
  return `${origin()}/v1/enterprise/public/client/${encodeURIComponent(slug)}/manifest`
}

function enrollmentBase(slug: string): string {
  return `${origin()}/v1/enterprise/public/client/${encodeURIComponent(slug)}/download`
}

function installerUrl(slug: string, platform: Platform): string {
  return `${enrollmentBase(slug)}/${platform}`
}

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function editablePayload(value: Distribution): Partial<Distribution> {
  return {
    name: value.name,
    slug: value.slug,
    description: value.description,
    branding: value.branding,
    auth: value.auth,
    features: value.features,
    permissions: value.permissions,
    experience: value.experience,
    limits: value.limits,
    models: value.models,
    telemetry: value.telemetry,
    update: value.update,
    deployment: value.deployment,
    releaseNotes: value.releaseNotes,
  }
}

function BuildPreview(props: { distribution: Distribution }) {
  const brand = () => props.distribution.branding
  const accent = () => brand().accentColor || "#2563eb"
  const primary = () => brand().primaryColor || "#0a0a0a"
  const domain = () =>
    props.distribution.auth.allowedEmailDomains.length > 0
      ? props.distribution.auth.allowedEmailDomains.join(", ")
      : "any work email"
  return (
    <div class="ent-device">
      <div class="ent-device-bar">
        <span class="ent-device-dot" />
        <span class="ent-device-dot" />
        <span class="ent-device-dot" />
      </div>
      <div class="ent-device-body">
        <Show
          when={brand().logoUrl ?? brand().iconUrl}
          fallback={
            <span
              class="ent-device-logo"
              style={{ background: `linear-gradient(135deg, ${primary()}, ${accent()})` }}
            >
              {(brand().shortName || props.distribution.name || "O").slice(0, 1).toUpperCase()}
            </span>
          }
        >
          {(url) => <img src={url()} alt="" style={{ height: "38px", "max-width": "120px", "object-fit": "contain" }} />}
        </Show>
        <h3>{brand().productName || props.distribution.name || "Your client"}</h3>
        <p>{brand().signInHeadline || "Sign in to continue"}</p>
        <div class="ent-device-field" />
        <div class="ent-device-field" />
        <div class="ent-device-button" style={{ background: accent() }}>
          Sign in
        </div>
        <span class="ent-device-note">
          SSO only · {domain()}
        </span>
        <Show when={!brand().showOmniaBranding}>
          <span class="ent-device-note">Powered by your team</span>
        </Show>
      </div>
    </div>
  )
}

export function DistributionEditorPage() {
  const session = useSession()
  const toast = useToast()
  const id = () => routeSegments()[1]
  const [detail] = createResource(id, (value) => (value === undefined ? undefined : api.distribution(value)))
  const [draft, setDraft] = createSignal<Distribution>()
  const [original, setOriginal] = createSignal("")
  const [tab, setTab] = createSignal<Tab>("branding")
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string>()
  const [publishing, setPublishing] = createSignal(false)
  const [publishVersion, setPublishVersion] = createSignal("")
  const [publishNotes, setPublishNotes] = createSignal("")
  const [publishError, setPublishError] = createSignal<string>()
  const [publishBusy, setPublishBusy] = createSignal(false)
  const [released, setRelease] = createSignal<Distribution>()
  const [assetBusy, setAssetBusy] = createSignal<"logo" | "icon">()
  const [assetError, setAssetError] = createSignal<string>()
  const [builds, { refetch: refetchBuilds }] = createResource(
    () => draft()?.id,
    async (value) => (value === undefined ? undefined : api.releases(value)),
  )
  const [buildBusy, setBuildBusy] = createSignal<string>()
  const [buildError, setBuildError] = createSignal<string>()
  const [logsFor, setLogsFor] = createSignal<ClientRelease>()
  const [assets, { refetch: refetchAssets }] = createResource(async () =>
    (await api.assets().catch(() => ({ ok: true as const, assets: [] }))).assets,
  )

  createEffect(() => {
    const result = detail()
    if (result === undefined) return
    if (draft()?.id === result.distribution.id) return
    setDraft(structuredClone(result.distribution))
    setOriginal(JSON.stringify(result.distribution))
  })

  // A build is a child process, not a request. Poll while anything is in
  // flight so the console reflects the toolchain output without a websocket.
  createEffect(() => {
    const overview = builds()
    if (overview === undefined) return
    if (!overview.releases.some((release) => release.status === "queued" || release.status === "building")) return
    const timer = setInterval(() => void refetchBuilds(), 2_000)
    onCleanup(() => clearInterval(timer))
  })

  const dirty = createMemo(() => draft() !== undefined && JSON.stringify(draft()) !== original())
  const canWrite = () => session.can("distributions:write")
  const canPublish = () => session.can("distributions:publish")
  const published = () => draft()?.status === "published"

  const edit = (change: (value: Distribution) => Distribution) => {
    setDraft((current) => (current === undefined ? current : change(current)))
  }
  const patchBranding = (patch: Partial<Branding>) =>
    edit((value) => ({ ...value, branding: { ...value.branding, ...patch } }))
  const patchAuth = (patch: Partial<ClientAuth>) =>
    edit((value) => ({ ...value, auth: { ...value.auth, mode: "sso", ...patch } }))
  const patchFeatures = (key: keyof ClientFeatures, enabled: boolean) =>
    edit((value) => {
      const features = { ...value.features, [key]: enabled }
      // Switching a capability off blocks its tool, so keep the rule visible
      // here instead of letting it disagree with the effective policy.
      const blocked = enabled === false ? FEATURE_PERMISSION[key] : undefined
      return {
        ...value,
        features,
        permissions: blocked === undefined ? value.permissions : { ...value.permissions, [blocked]: "deny" },
      }
    })
  const patchPermission = (key: keyof ClientPermissions, mode: PermissionMode) =>
    edit((value) => ({ ...value, permissions: { ...value.permissions, [key]: mode } }))
  const applyPermissions = (values: ClientPermissions) =>
    edit((value) => ({ ...value, permissions: { ...values } }))
  const patchExperience = (patch: Partial<ClientExperience>) =>
    edit((value) => ({ ...value, experience: { ...value.experience, ...patch } }))

  const pickAsset = (kind: "logo" | "icon") => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "image/png,image/jpeg,image/webp,image/svg+xml"
    input.onchange = async () => {
      const file = input.files?.[0]
      if (file === undefined) return
      if (file.size > 512 * 1024) {
        setAssetError("Images must be 512 KB or smaller.")
        return
      }
      setAssetBusy(kind)
      setAssetError(undefined)
      try {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(new Error("The image could not be read."))
          reader.readAsDataURL(file)
        })
        const uploaded = await api.uploadAsset({ kind, contentType: file.type, data })
        patchBranding(kind === "logo" ? { logoUrl: uploaded.url } : { iconUrl: uploaded.url })
        void refetchAssets()
        toast.push("Asset uploaded. Save the build to publish it.", "success")
      } catch (cause) {
        setAssetError(cause instanceof Error ? cause.message : "The image could not be uploaded.")
      } finally {
        setAssetBusy(undefined)
      }
    }
    input.click()
  }
  const patchLimits = (key: keyof ClientLimits, amount: number) =>
    edit((value) => ({ ...value, limits: { ...value.limits, [key]: Math.max(0, amount) } }))
  const patchModels = (patch: Partial<ModelAccess>) =>
    edit((value) => ({ ...value, models: { ...value.models, ...patch } }))
  const patchTelemetry = (patch: Partial<Distribution["telemetry"]>) =>
    edit((value) => ({ ...value, telemetry: { ...value.telemetry, ...patch } }))
  const patchUpdate = (patch: Partial<Distribution["update"]>) =>
    edit((value) => ({ ...value, update: { ...value.update, ...patch } }))
  const patchDeployment = (patch: Partial<Distribution["deployment"]>) =>
    edit((value) => ({ ...value, deployment: { ...value.deployment, ...patch } }))

  const save = async () => {
    const value = draft()
    if (value === undefined || !dirty()) return
    setSaving(true)
    setSaveError(undefined)
    try {
      const result = await api.updateDistribution(value.id, editablePayload(value))
      setDraft(structuredClone(result.distribution))
      setOriginal(JSON.stringify(result.distribution))
      setRelease(undefined)
      toast.push("Build saved.", "success")
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not save the build.")
    } finally {
      setSaving(false)
    }
  }

  const openPublish = () => {
    const value = draft()
    if (value === undefined) return
    setRelease(undefined)
    setPublishVersion(nextVersion(value.version, value.status === "published"))
    setPublishNotes(value.releaseNotes)
    setPublishError(undefined)
    setPublishing(true)
  }

  const publish = async () => {
    const value = draft()
    if (value === undefined) return
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(publishVersion())) {
      setPublishError("Use a version like 1.4.0 or 1.4.0-beta.1.")
      return
    }
    setPublishBusy(true)
    setPublishError(undefined)
    try {
      // Publishing releases the draft that is on screen, not a stale server copy.
      if (dirty()) await api.updateDistribution(value.id, editablePayload(value))
      const result = await api.publishDistribution(value.id, {
        version: publishVersion(),
        releaseNotes: publishNotes(),
      })
      setDraft(structuredClone(result.distribution))
      setOriginal(JSON.stringify(result.distribution))
      setRelease(result.distribution)
      setTab("release")
      toast.push(`Published ${result.distribution.name} v${result.distribution.version}.`, "success")
    } catch (cause) {
      setPublishError(cause instanceof Error ? cause.message : "Could not publish the build.")
    } finally {
      setPublishBusy(false)
    }
  }

  const removeAsset = async (name: string) => {
    setAssetError(undefined)
    try {
      await api.deleteAsset(name)
      void refetchAssets()
      toast.push("Asset removed.", "success")
    } catch (cause) {
      setAssetError(cause instanceof Error ? cause.message : "The asset could not be removed.")
    }
  }

  const togglePlatform = (platform: Platform, enabled: boolean) => {
    const value = draft()
    if (value === undefined) return
    const platforms = enabled
      ? [...new Set([...value.deployment.platforms, platform])]
      : value.deployment.platforms.filter((entry) => entry !== platform)
    patchDeployment({ platforms })
  }

  const hostTarget = (platform: Platform) => builds()?.targets.find((entry) => entry.platform === platform)

  /** The artifact for the version that is on screen; older builds are not offered. */
  const releaseFor = (platform: Platform) => {
    const value = draft()
    if (value === undefined) return undefined
    return builds()
      ?.releases.filter((release) => release.platform === platform && release.version === value.version)
      .sort((left, right) => right.startedAt - left.startedAt)[0]
  }

  const startBuild = async (platforms: Platform[]) => {
    const value = draft()
    if (value === undefined || !canWrite() || platforms.length === 0) return
    setBuildBusy(platforms.join(","))
    setBuildError(undefined)
    try {
      // The farm packages the saved distribution, so a dirty draft would build
      // the previous version and platform list.
      if (dirty()) {
        const saved = await api.updateDistribution(value.id, editablePayload(value))
        setDraft(structuredClone(saved.distribution))
        setOriginal(JSON.stringify(saved.distribution))
      }
      const result = await api.buildDistribution(value.id, platforms)
      if (result.errors.length > 0) setBuildError(result.errors.join(" "))
      await refetchBuilds()
      toast.push(
        platforms.length === 1 ? `Build started for ${platforms[0]}.` : `Build started for ${platforms.length} platforms.`,
        "success",
      )
    } catch (cause) {
      setBuildError(cause instanceof Error ? cause.message : "The build could not be started.")
    } finally {
      setBuildBusy(undefined)
    }
  }

  const buildablePlatforms = () =>
    draft()!.deployment.platforms.filter((platform) => hostTarget(platform)?.supported === true)

  /** Follow the polled record so an open log keeps growing during a build. */
  const openLog = () => {
    const value = logsFor()
    if (value === undefined) return undefined
    return builds()?.releases.find((release) => release.id === value.id) ?? value
  }

  return (
    <div class="ent-page">
      <Show when={detail.loading}>
        <div class="ent-stack">
          <Skeleton height={54} />
          <Skeleton height={320} />
        </div>
      </Show>

      <Show when={detail.error}>
        <EmptyState
          icon="warning"
          title="Could not open this build"
          description={detail.error instanceof Error ? detail.error.message : "The build may have been deleted."}
          action={
            <Button variant="secondary" onClick={() => navigate("/distributions")}>
              All client builds
            </Button>
          }
        />
      </Show>

      <Show when={!detail.loading && !detail.error && draft() !== undefined}>
        <button
          type="button"
          class="ent-button dist-back"
          data-variant="ghost"
          data-size="small"
          onClick={() => navigate("/distributions")}
        >
          <Icon name="arrow-left" size="small" />
          <span>All client builds</span>
        </button>

        <PageHeader
          kicker={published() ? "Published client" : "Draft client"}
          title={draft()!.name}
          description={`Manifest /client/${draft()!.slug} · ${draft()!.status === "published" ? `v${draft()!.version} live` : "not visible to clients until published"}`}
          actions={
            <>
              <Show when={dirty()}>
                <Tag tone="warning" dot>
                  Unsaved
                </Tag>
              </Show>
              <Tag tone={published() ? "success" : "warning"} dot>
                {draft()!.status}
              </Tag>
              <Show when={canWrite()}>
                <Button variant="secondary" loading={saving()} disabled={!dirty()} onClick={() => void save()}>
                  Save changes
                </Button>
              </Show>
              <Show when={canPublish()}>
                <Button variant="primary" icon="arrow-up" onClick={openPublish}>
                  Publish
                </Button>
              </Show>
            </>
          }
        />

        <Show when={saveError()}>
          <div style={{ "margin-bottom": "12px" }}>
            <InlineNote tone="danger" icon="warning">
              {saveError()}
            </InlineNote>
          </div>
        </Show>

        <Show when={published()}>
          <div style={{ "margin-bottom": "12px" }}>
            <InlineNote tone="accent" icon="eye">
              This build is live. Saving changes updates the manifest that clients read on their next launch;
              publish a new version to prompt installed clients to update.
            </InlineNote>
          </div>
        </Show>

        <Show when={published() && detail()?.manifest !== undefined}>
          <div style={{ "margin-bottom": "12px" }}>
            <div class="ent-row ent-wrap">
              <span class="ent-label" style={{ "flex": "none" }}>Live manifest</span>
              <div style={{ flex: "1", "min-width": "280px" }}>
                <CopyField value={manifestUrl(draft()!.slug)} />
              </div>
            </div>
          </div>
        </Show>

        <div class="ent-builder">
          <div class="ent-stack">
            <div class="dist-tabs">
              <Tabs
                tabs={TABS.map((entry) => ({
                  id: entry.id,
                  label: entry.label,
                  ...(entry.id === "features"
                    ? { count: FEATURES.filter((feature) => draft()!.features[feature.key]).length }
                    : {}),
                }))}
                active={tab()}
                onChange={(id) => setTab(id)}
              />
            </div>

            <Show when={tab() === "branding"}>
              <div class="ent-stack">
                <Card title="Build identity" description="The stable name and URL used by the manifest and enrollment links.">
                  <div class="ent-form-grid">
                    <Field label="Build name" required>
                      <Input value={draft()!.name} onInput={(value) => edit((current) => ({ ...current, name: value }))} />
                    </Field>
                    <Field
                      label="Manifest slug"
                      hint="Changing this breaks existing enrollment links until clients refresh their manifest URL."
                    >
                      <Input
                        value={draft()!.slug}
                        onInput={(value) => edit((current) => ({ ...current, slug: slugify(value) }))}
                      />
                    </Field>
                    <Field label="Internal description" class="ent-span-2">
                      <Textarea
                        value={draft()!.description}
                        onInput={(value) => edit((current) => ({ ...current, description: value }))}
                        rows={2}
                      />
                    </Field>
                  </div>
                </Card>

                <Card title="Brand" description="Your name, mark and colors replace the default client identity.">
                  <div class="ent-form-grid">
                    <Field label="Product name" required hint="The name in the title bar and sign-in screen.">
                      <Input
                        value={draft()!.branding.productName}
                        onInput={(value) => patchBranding({ productName: value })}
                      />
                    </Field>
                    <Field label="Short name" hint="Used where space is tight, such as the launcher.">
                      <Input value={draft()!.branding.shortName} onInput={(value) => patchBranding({ shortName: value })} />
                    </Field>
                    <Field label="Tagline" class="ent-span-2">
                      <Input value={draft()!.branding.tagline} onInput={(value) => patchBranding({ tagline: value })} />
                    </Field>
                    <Field label="Logo URL" hint="HTTPS, or upload a PNG, JPEG, WebP or SVG up to 512 KB.">
                      <div class="ent-row" style={{ gap: "8px" }}>
                        <div style={{ flex: "1" }}>
                          <Input value={draft()!.branding.logoUrl ?? ""} onInput={(value) => patchBranding({ logoUrl: value })} />
                        </div>
                        <Button
                          variant="secondary"
                          size="small"
                          icon="cloud-upload"
                          disabled={!canWrite() || assetBusy() !== undefined}
                          onClick={() => pickAsset("logo")}
                        >
                          {assetBusy() === "logo" ? "Uploading…" : "Upload"}
                        </Button>
                      </div>
                    </Field>
                    <Field label="Icon URL" hint="Square mark for the desktop and dock. Same size limit.">
                      <div class="ent-row" style={{ gap: "8px" }}>
                        <div style={{ flex: "1" }}>
                          <Input value={draft()!.branding.iconUrl ?? ""} onInput={(value) => patchBranding({ iconUrl: value })} />
                        </div>
                        <Button
                          variant="secondary"
                          size="small"
                          icon="cloud-upload"
                          disabled={!canWrite() || assetBusy() !== undefined}
                          onClick={() => pickAsset("icon")}
                        >
                          {assetBusy() === "icon" ? "Uploading…" : "Upload"}
                        </Button>
                      </div>
                    </Field>
                    <Field label="Primary color">
                      <div class="dist-color-row">
                        <input
                          type="color"
                          class="dist-color"
                          value={draft()!.branding.primaryColor}
                          onInput={(event) => patchBranding({ primaryColor: event.currentTarget.value })}
                        />
                        <Input
                          value={draft()!.branding.primaryColor}
                          onInput={(value) => patchBranding({ primaryColor: value })}
                        />
                      </div>
                    </Field>
                    <Field label="Accent color">
                      <div class="dist-color-row">
                        <input
                          type="color"
                          class="dist-color"
                          value={draft()!.branding.accentColor}
                          onInput={(event) => patchBranding({ accentColor: event.currentTarget.value })}
                        />
                        <Input
                          value={draft()!.branding.accentColor}
                          onInput={(value) => patchBranding({ accentColor: value })}
                        />
                      </div>
                    </Field>
                  </div>
                  <Show when={assetError()}>
                    <div style={{ "margin-top": "10px" }}>
                      <InlineNote tone="danger" icon="warning">
                        {assetError()}
                      </InlineNote>
                    </div>
                  </Show>
                  <div class="ent-section-divider" style={{ "margin-top": "16px" }}>
                    <span>Attribution</span>
                  </div>
                  <Switch
                    checked={draft()!.branding.showOmniaBranding}
                    onChange={(value) => patchBranding({ showOmniaBranding: value })}
                    label="Show “Powered by Omnia” in the client"
                    description="Turn this off for a fully white-labelled build. Enterprise licenses may remove attribution."
                  />
                </Card>

                <Show when={(assets()?.length ?? 0) > 0}>
                  <Card
                    title="Branding assets"
                    description="Images uploaded to this server. They are served from your deployment, so air-gapped clients can load them too."
                    actions={<Tag tone="muted">{assets()!.length} / 24</Tag>}
                  >
                    <div class="ent-stack" style={{ gap: "0" }}>
                      <For each={assets()!}>
                        {(asset) => (
                          <div class="ent-list-row">
                            <span class="ent-asset-thumb">
                              <img src={asset.url} alt="" loading="lazy" />
                            </span>
                            <span class="ent-list-row-main">
                              <span class="ent-list-row-title">{asset.name}</span>
                              <span class="ent-list-row-sub">
                                {Math.max(1, Math.round(asset.bytes / 1024))} KB · uploaded {relative(asset.createdAt)}
                              </span>
                            </span>
                            <Button
                              size="small"
                              variant="ghost"
                              icon="trash"
                              disabled={!canWrite()}
                              onClick={() => void removeAsset(asset.name)}
                            >
                              Remove
                            </Button>
                          </div>
                        )}
                      </For>
                    </div>
                    <div style={{ "margin-top": "10px" }}>
                      <InlineNote icon="help">
                        Up to 24 files, 512 KB each. Removing a file that a build still references is blocked, so a
                        live client never loses its mark.
                      </InlineNote>
                    </div>
                  </Card>
                </Show>

                <Card title="Sign-in screen" description="Copy shown before anyone enters the workspace.">
                  <div class="ent-form-grid">
                    <Field label="Headline" class="ent-span-2">
                      <Input
                        value={draft()!.branding.signInHeadline}
                        onInput={(value) => patchBranding({ signInHeadline: value })}
                      />
                    </Field>
                    <Field label="Subheadline" class="ent-span-2">
                      <Textarea
                        value={draft()!.branding.signInSubheadline}
                        onInput={(value) => patchBranding({ signInSubheadline: value })}
                        rows={2}
                      />
                    </Field>
                    <Field label="Support URL" hint="Shown in the client's help menu.">
                      <Input value={draft()!.branding.supportUrl ?? ""} onInput={(value) => patchBranding({ supportUrl: value })} />
                    </Field>
                    <Field label="Documentation URL">
                      <Input value={draft()!.branding.docsUrl ?? ""} onInput={(value) => patchBranding({ docsUrl: value })} />
                    </Field>
                    <Field label="Footer text" hint="Small print under the sign-in form." class="ent-span-2">
                      <Input value={draft()!.branding.footerText ?? ""} onInput={(value) => patchBranding({ footerText: value })} />
                    </Field>
                  </div>
                </Card>
              </div>
            </Show>

            <Show when={tab() === "auth"}>
              <div class="ent-stack">
                <div class="dist-lock">
                  <span class="ent-auth-point-icon">
                    <Icon name="shield" size="small" />
                  </span>
                  <div>
                    <strong>Single sign-on only</strong>
                    <p>
                      Enterprise builds never accept personal or social accounts. There is no GitHub or Google
                      button in this format, and this setting cannot be enabled.
                    </p>
                  </div>
                  <Tag tone="success" dot>
                    enforced
                  </Tag>
                </div>

                <Card title="Sign-in policy" description="Every build uses work-account credentials issued by this server. There is no social sign-in.">
                  <div class="dist-lock">
                    <span class="ent-auth-point-icon">
                      <Icon name="shield" size="small" />
                    </span>
                    <div>
                      <strong>Email address or employee ID + password</strong>
                      <p>
                        Accounts are created by invitation, or provisioned directly from your identity provider
                        through SCIM. Passwords can be reset by an administrator at any time.
                      </p>
                    </div>
                    <Tag tone="neutral">only</Tag>
                  </div>
                  <div class="ent-form-grid" style={{ "margin-top": "14px" }}>
                    <Field label="Session length" hint="Hours before a client token expires.">
                      <Input
                        type="number"
                        min={1}
                        max={720}
                        value={draft()!.auth.sessionHours}
                        onInput={(value) => patchAuth({ sessionHours: Math.max(1, Number(value) || 1) })}
                      />
                    </Field>
                    <Field label="Allowed email domains" hint="Comma or newline separated. Empty allows any verified account on this server.">
                      <Input
                        value={draft()!.auth.allowedEmailDomains.join(", ")}
                        onInput={(value) => patchAuth({ allowedEmailDomains: parseList(value) })}
                        placeholder="acme.com, acme.co.uk"
                      />
                    </Field>
                  </div>
                  <Switch
                    checked={draft()!.auth.requireMfa}
                    onChange={(value) => patchAuth({ requireMfa: value })}
                    label="Mark multi-factor as required"
                    description="Signals the requirement to users and auditors. Pair it with an SSO gateway or device policy that actually enforces a second factor."
                  />
                  <InlineNote>
                    Federated OIDC and SAML are not terminated by this console. Point your identity provider at a
                    gateway in front of this server, or use SCIM to keep local accounts in sync.
                  </InlineNote>
                </Card>

              </div>
            </Show>

            <Show when={tab() === "features"}>
              <Card title="Capability surface" description="Switches are shipped in the manifest. Off means the client does not offer the capability at all.">
                <div class="dist-feature-grid">
                  <For each={FEATURES}>
                    {(feature) => (
                      <Switch
                        checked={draft()!.features[feature.key]}
                        onChange={(value) => patchFeatures(feature.key, value)}
                        label={feature.label}
                        description={feature.description}
                      />
                    )}
                  </For>
                </div>
                <div style={{ "margin-top": "14px" }}>
                  <InlineNote icon="shield">
                    Organization policies are the outer boundary. A feature switched on here still obeys the
                    deployment's tool, model and data policy.
                  </InlineNote>
                </div>
              </Card>
              <Card
                title="Tool permissions"
                description="Per-tool rules shipped in the manifest. Ask first pauses the agent for approval; Block removes the tool before the model can call it."
              >
                <div style={{ display: "flex", "flex-wrap": "wrap", gap: "8px", "margin-bottom": "14px" }}>
                  <For each={PERMISSION_PRESETS}>
                    {(preset) => (
                      <Button variant="secondary" size="small" onClick={() => applyPermissions(preset.values)}>
                        {preset.label}
                      </Button>
                    )}
                  </For>
                </div>
                <div class="ent-form-grid">
                  <For each={PERMISSIONS}>
                    {(entry) => (
                      <Field label={entry.label} hint={entry.description}>
                        <Select
                          value={draft()!.permissions?.[entry.key] ?? "allow"}
                          onChange={(mode) => patchPermission(entry.key, mode)}
                          options={PERMISSION_OPTIONS}
                        />
                      </Field>
                    )}
                  </For>
                </div>
                <div style={{ "margin-top": "14px" }}>
                  <InlineNote icon="shield">
                    A capability switched off above always blocks its tool, whatever this page says. Rules are
                    enforced inside the client's agent, not only by hiding controls.
                  </InlineNote>
                </div>
              </Card>
            </Show>

            <Show when={tab() === "experience"}>
              <div class="ent-stack">
                <Card title="First launch" description="How the client looks and where it opens for everyone on this build.">
                  <div class="ent-form-grid">
                    <Field label="Appearance" hint="Follow the operating system, or pin a theme.">
                      <Select
                        value={draft()!.experience.theme}
                        onChange={(value) => patchExperience({ theme: value })}
                        options={[
                          { value: "system", label: "Match the system" },
                          { value: "light", label: "Light" },
                          { value: "dark", label: "Dark" },
                        ]}
                      />
                    </Field>
                    <Field label="Density" hint="Compact fits more rows on a small laptop.">
                      <Select
                        value={draft()!.experience.density}
                        onChange={(value) => patchExperience({ density: value })}
                        options={[
                          { value: "comfortable", label: "Comfortable" },
                          { value: "compact", label: "Compact" },
                        ]}
                      />
                    </Field>
                    <Field label="Language" hint="System follows the operating system locale.">
                      <Select
                        value={draft()!.experience.locale}
                        onChange={(value) => patchExperience({ locale: value })}
                        options={[
                          { value: "system", label: "Match the system" },
                          { value: "en", label: "English" },
                          { value: "de", label: "Deutsch" },
                          { value: "ar", label: "العربية" },
                        ]}
                      />
                    </Field>
                    <Field label="Home surface" hint="What a person sees first after signing in.">
                      <Select
                        value={draft()!.experience.homeSurface}
                        onChange={(value) => patchExperience({ homeSurface: value })}
                        options={[
                          { value: "sessions", label: "Recent sessions" },
                          { value: "projects", label: "Projects and workspaces" },
                        ]}
                      />
                    </Field>
                    <Field label="Default mode" hint="Plan asks before editing; build acts immediately.">
                      <Select
                        value={draft()!.experience.defaultMode}
                        onChange={(value) => patchExperience({ defaultMode: value })}
                        options={[
                          { value: "build", label: "Build" },
                          { value: "plan", label: "Plan" },
                        ]}
                      />
                    </Field>
                    <div />
                  </div>
                  <div style={{ "margin-top": "10px" }}>
                    <Switch
                      checked={draft()!.experience.showTips}
                      onChange={(value) => patchExperience({ showTips: value })}
                      label="Show onboarding tips"
                      description="Short, dismissible hints for people who have not used an agent before."
                    />
                    <Switch
                      checked={draft()!.experience.showUsageMeter}
                      onChange={(value) => patchExperience({ showUsageMeter: value })}
                      label="Show the usage meter"
                      description="Surface the person's remaining tokens and spend against the limits below."
                    />
                  </div>
                </Card>

                <Card title="House style" description="Organization-wide instructions applied before every session, alongside project rules.">
                  <Field
                    label="Default instructions"
                    hint="Plain text. Keep it short and factual: languages, review rules, paths to never touch, and who to ask."
                  >
                    <Textarea
                      value={draft()!.experience.instructions}
                      onInput={(value) => patchExperience({ instructions: value })}
                      rows={6}
                      placeholder={
                        "Prefer TypeScript. Never run destructive database commands. Ask before adding a dependency. Follow the repository AGENTS.md."
                      }
                    />
                  </Field>
                  <div style={{ "margin-top": "10px" }}>
                    <InlineNote icon="shield">
                      Instructions guide the model; they do not grant permissions. Tool, model and data policy still
                      decide what the client may do.
                    </InlineNote>
                  </div>
                </Card>
              </div>
            </Show>

            <Show when={tab() === "limits"}>
              <Card title="Per-person limits" description="Ceilings enforced by the client and reported back with usage.">
                <div class="ent-form-grid">
                  <For each={LIMITS}>
                    {(limit) => (
                      <Field label={limit.label} hint={limit.hint}>
                        <Input
                          type="number"
                          min={0}
                          step={limit.step ?? 1}
                          value={draft()!.limits[limit.key]}
                          onInput={(value) => patchLimits(limit.key, Number(value) || 0)}
                        />
                      </Field>
                    )}
                  </For>
                </div>
                <div style={{ "margin-top": "14px" }}>
                  <InlineNote icon="models">
                    Context window is a request, not a promise: the provider's own model limit still wins.
                  </InlineNote>
                </div>
              </Card>
            </Show>

            <Show when={tab() === "models"}>
              <div class="ent-stack">
                <Card title="Model access" description="Pin the models this build may use. The organization policy still applies on top.">
                  <div class="ent-form-grid">
                    <Field label="Default model" hint="Provider/model id used for new sessions.">
                      <Input
                        value={draft()!.models.defaultModel}
                        onInput={(value) => patchModels({ defaultModel: value })}
                        placeholder="opencode/big"
                      />
                    </Field>
                    <div />
                    <Field label="Allowed models" hint="One per line. Empty means every model allowed by policy." class="ent-span-2">
                      <Textarea
                        value={draft()!.models.allowed.join("\n")}
                        onInput={(value) => patchModels({ allowed: parseList(value) })}
                        rows={4}
                        placeholder={"anthropic/claude-sonnet\nopenai/gpt-5"}
                      />
                    </Field>
                    <Field label="Blocked models" hint="Wins over the allowlist." class="ent-span-2">
                      <Textarea
                        value={draft()!.models.blocked.join("\n")}
                        onInput={(value) => patchModels({ blocked: parseList(value) })}
                        rows={3}
                      />
                    </Field>
                  </div>
                  <div class="ent-stack" style={{ gap: "0" }}>
                    <Switch
                      checked={draft()!.models.allowCustomProviders}
                      onChange={(value) => patchModels({ allowCustomProviders: value })}
                      label="Allow custom providers"
                      description="Let people add their own OpenAI-compatible endpoint to this build."
                    />
                    <Switch
                      checked={draft()!.models.allowByok}
                      onChange={(value) => patchModels({ allowByok: value })}
                      label="Allow bring-your-own-key"
                      description="People may use a personal provider key. Disable to keep all spend on the organization account."
                    />
                  </div>
                </Card>
              </div>
            </Show>

            <Show when={tab() === "telemetry"}>
              <Card title="Telemetry" description="What this client may report, and for how long.">
                <Switch
                  checked={draft()!.telemetry.enabled}
                  onChange={(value) => patchTelemetry({ enabled: value })}
                  label="Send product telemetry"
                  description="Anonymous capability and crash data. Usage accounting is separate and always on."
                />
                <Switch
                  checked={draft()!.telemetry.includePrompts}
                  onChange={(value) => patchTelemetry({ includePrompts: value })}
                  label="Include prompt text"
                  description="Sensitive. Leave off unless your policy explicitly permits it."
                />
                <Switch
                  checked={draft()!.telemetry.includeFilePaths}
                  onChange={(value) => patchTelemetry({ includeFilePaths: value })}
                  label="Include file paths"
                  description="Useful for diagnosing tools, but reveals project structure."
                />
                <div class="ent-form-grid" style={{ "margin-top": "12px" }}>
                  <Field label="Retention (days)">
                    <Input
                      type="number"
                      min={1}
                      max={3650}
                      value={draft()!.telemetry.retentionDays}
                      onInput={(value) => patchTelemetry({ retentionDays: Math.max(1, Number(value) || 1) })}
                    />
                  </Field>
                  <Field label="Collector endpoint" hint="Leave empty to use the organization default.">
                    <Input
                      value={draft()!.telemetry.endpoint ?? ""}
                      onInput={(value) => patchTelemetry({ endpoint: value })}
                      placeholder="https://telemetry.example.com/omnia"
                    />
                  </Field>
                </div>
              </Card>
            </Show>

            <Show when={tab() === "updates"}>
              <Card title="Update channel" description="Installed clients read this policy on launch.">
                <div class="ent-form-grid">
                  <Field label="Channel" hint="Pinned keeps everyone on one version until you move the pin.">
                    <Select
                      value={draft()!.update.channel}
                      onChange={(value: Distribution["update"]["channel"]) => patchUpdate({ channel: value })}
                      options={[
                        { value: "stable", label: "Stable" },
                        { value: "beta", label: "Beta" },
                        { value: "pinned", label: "Pinned" },
                      ]}
                    />
                  </Field>
                  <Show when={draft()!.update.channel === "pinned"}>
                    <Field label="Pinned version" hint="For example 1.4.0.">
                      <Input
                        value={draft()!.update.pinnedVersion ?? ""}
                        onInput={(value) => patchUpdate({ pinnedVersion: value })}
                      />
                    </Field>
                  </Show>
                  <Field label="Minimum version" hint="Older clients are told to update before signing in.">
                    <Input
                      value={draft()!.update.minimumVersion ?? ""}
                      onInput={(value) => patchUpdate({ minimumVersion: value })}
                    />
                  </Field>
                </div>
                <Switch
                  checked={draft()!.update.autoUpdate}
                  onChange={(value) => patchUpdate({ autoUpdate: value })}
                  label="Install updates automatically"
                  description="Off means people are notified and choose when to restart."
                />
                <Switch
                  checked={draft()!.update.allowDowngrade}
                  onChange={(value) => patchUpdate({ allowDowngrade: value })}
                  label="Allow downgrades"
                  description="Normally off: a rollback should be a deliberate support action."
                />
              </Card>
            </Show>

            <Show when={tab() === "platforms"}>
              <div class="ent-stack">
                <Card title="Reachability" description="Where clients install from, and how far they can roam.">
                  <div class="ent-form-grid">
                    <Field
                      label="Deployment mode"
                      hint="LAN answers clients at whatever address they reached. Anywhere pins one URL."
                      class="ent-span-2"
                    >
                      <Select<NetworkMode>
                        value={draft()!.deployment.mode}
                        onChange={(value) => patchDeployment({ mode: value })}
                        options={[
                          { value: "lan", label: "Private network (LAN only)" },
                          { value: "public", label: "Anywhere (public URL)" },
                        ]}
                      />
                    </Field>
                  </div>
                  <Show when={draft()!.deployment.mode === "lan"}>
                    <InlineNote icon="server">
                      Installers and the manifest are served from the address the client used, so this server
                      needs no public DNS name. Clients only reach it while they are on the same network.
                    </InlineNote>
                  </Show>
                  <Show when={draft()!.deployment.mode === "public"}>
                    <InlineNote tone={draft()!.telemetry.enabled ? "success" : "warning"} icon="shield">
                      {draft()!.telemetry.enabled
                        ? "Off-network clients report usage and sign-ins back to this deployment, so activity stays traceable."
                        : "Anywhere builds can leave the network, so publishing requires client telemetry. Turn it on under Telemetry first."}
                    </InlineNote>
                  </Show>
                </Card>

                <Card title="Target platforms" description="Each selected platform gets a real installer, or an enrollment file until one is built.">
                  <div class="dist-platform-grid">
                    <For each={PLATFORMS}>
                      {(platform) => (
                        <Checkbox
                          checked={draft()!.deployment.platforms.includes(platform.id)}
                          onChange={(value) => togglePlatform(platform.id, value)}
                          label={platform.label}
                        />
                      )}
                    </For>
                  </div>
                  <div class="ent-form-grid" style={{ "margin-top": "14px" }}>
                    <Field
                      label="Installer base URL"
                      hint="Where signed installers live when a separate CDN serves them. Empty uses this server."
                      class="ent-span-2"
                    >
                      <Input
                        value={draft()!.deployment.installerBaseUrl ?? ""}
                        onInput={(value) => patchDeployment({ installerBaseUrl: value })}
                        placeholder="https://downloads.example.com/omnia"
                      />
                    </Field>
                    <Field label="Proxy URL" hint="Corporate egress proxy used by the client.">
                      <Input
                        value={draft()!.deployment.proxyUrl ?? ""}
                        onInput={(value) => patchDeployment({ proxyUrl: value })}
                        placeholder="http://proxy.example.com:8080"
                      />
                    </Field>
                    <div />
                    <Field label="Custom CA certificate" class="ent-span-2" hint="PEM bundle for TLS inspection appliances.">
                      <Textarea
                        value={draft()!.deployment.customCaCertificate ?? ""}
                        onInput={(value) => patchDeployment({ customCaCertificate: value })}
                        rows={4}
                      />
                    </Field>
                  </div>
                  <Switch
                    checked={draft()!.deployment.offlineBundle}
                    onChange={(value) => patchDeployment({ offlineBundle: value })}
                    label="Ship an offline enrollment bundle"
                    description="Include model and runtime configuration so a device can be staged without internet access."
                  />
                </Card>
                <Card
                  title="Installers"
                  description={`Packages version ${draft()!.version} with this server's toolchain. Builds run on the server and are filed beside its state.`}
                >
                  <Show when={builds()?.build === false}>
                    <InlineNote tone="warning" icon="warning">
                      Client builds are disabled on this deployment. Manifests point at enrollment files only.
                    </InlineNote>
                  </Show>
                  <Show when={builds() !== undefined && builds()!.host.ready === false}>
                    <InlineNote tone="warning" icon="server">
                      {builds()!.host.reason}
                    </InlineNote>
                  </Show>
                  <div class="dist-build-list">
                    <For each={PLATFORMS.filter((platform) => draft()!.deployment.platforms.includes(platform.id))}>
                      {(platform) => {
                        const target = () => hostTarget(platform.id)
                        const release = () => releaseFor(platform.id)
                        const busy = () => release()?.status === "queued" || release()?.status === "building"
                        return (
                          <div class="dist-build-row">
                            <div class="dist-build-main">
                              <span class="dist-build-title">{platform.label}</span>
                              <span class="ent-small ent-faint">
                                {target()?.artifact ?? "installer"}
                                <Show when={target() !== undefined && !target()!.supported}> · {target()!.reason}</Show>
                              </span>
                            </div>
                            <Show
                              when={release()}
                              fallback={<Tag tone="neutral">Not built</Tag>}
                            >
                              {(value) => (
                                <Tag
                                  tone={
                                    value().status === "ready"
                                      ? "success"
                                      : value().status === "failed"
                                        ? "danger"
                                        : "accent"
                                  }
                                  dot
                                >
                                  {value().status === "building" ? "Building" : value().status}
                                </Tag>
                              )}
                            </Show>
                            <Show when={release()?.status === "ready"}>
                              <span class="dist-build-meta">
                                {size(release()!.bytes ?? 0)} · <code>{release()!.sha256?.slice(0, 12)}</code>
                              </span>
                            </Show>
                            <div class="dist-build-actions">
                              <Button
                                variant={release()?.status === "ready" ? "ghost" : "secondary"}
                                size="small"
                                loading={buildBusy() === platform.id}
                                disabled={!canWrite() || target()?.supported !== true || busy()}
                                onClick={() => void startBuild([platform.id])}
                              >
                                {release()?.status === "ready" ? "Rebuild" : "Build"}
                              </Button>
                              <Show when={release() !== undefined}>
                                <Button variant="ghost" size="small" onClick={() => setLogsFor(release())}>
                                  Log
                                </Button>
                              </Show>
                              <Show when={release()?.status === "ready" && draft()!.status === "published"}>
                                <Button
                                  variant="secondary"
                                  size="small"
                                  icon="download"
                                  onClick={() => window.location.assign(installerUrl(draft()!.slug, platform.id))}
                                >
                                  Download
                                </Button>
                              </Show>
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                  <Show when={draft()!.deployment.platforms.length === 0}>
                    <InlineNote tone="warning" icon="warning">
                      Select at least one platform before building an installer.
                    </InlineNote>
                  </Show>
                  <div class="ent-row" style={{ "margin-top": "12px" }}>
                    <Button
                      variant="primary"
                      size="small"
                      loading={buildBusy() === buildablePlatforms().join(",")}
                      disabled={!canWrite() || buildablePlatforms().length === 0}
                      onClick={() => void startBuild(buildablePlatforms())}
                    >
                      Build all supported platforms
                    </Button>
                    <Show when={builds() !== undefined}>
                      <span class="ent-small ent-faint">
                        {builds()!.host.ready
                          ? `Building on ${builds()!.host.platform}/${builds()!.host.arch}`
                          : "This host cannot build client packages"}
                      </span>
                    </Show>
                  </div>
                  <Show when={buildError()}>
                    <InlineNote tone="danger" icon="warning">
                      {buildError()}
                    </InlineNote>
                  </Show>
                </Card>

                <InlineNote icon="server">
                  Download URL: <code>{enrollmentBase(draft()!.slug)}/&lt;platform&gt;</code>. It serves the built
                  installer, starting a build the first time it is requested, and falls back to an enrollment file
                  only when this host cannot package that platform.
                </InlineNote>
              </div>
            </Show>

            <Show when={tab() === "release"}>
              <div class="ent-stack">
                <Card title="Release" description="Publishing pins a version and writes an audit event.">
                  <div class="ent-grid ent-grid-3" style={{ "margin-bottom": "14px" }}>
                    <div>
                      <div class="ent-label">Current version</div>
                      <div class="ent-mono" style={{ "font-size": "14px" }}>
                        {draft()!.version}
                      </div>
                    </div>
                    <div>
                      <div class="ent-label">Status</div>
                      <Tag tone={published() ? "success" : "warning"} dot>
                        {draft()!.status}
                      </Tag>
                    </div>
                    <div>
                      <div class="ent-label">Published</div>
                      <div class="ent-small">{draft()!.publishedAt === undefined ? "Not yet" : date(draft()!.publishedAt)}</div>
                    </div>
                  </div>
                  <Field label="Release notes" hint="Shown in the client update prompt and kept in the release history.">
                    <Textarea
                      value={draft()!.releaseNotes}
                      onInput={(value) => edit((current) => ({ ...current, releaseNotes: value }))}
                      rows={6}
                      placeholder="What changed in this build, and anything people should know before updating."
                    />
                  </Field>
                  <div class="ent-row" style={{ "margin-top": "12px" }}>
                    <Show when={canPublish()}>
                      <Button variant="primary" icon="arrow-up" onClick={openPublish}>
                        Publish release
                      </Button>
                    </Show>
                    <Show when={dirty()}>
                      <span class="ent-small ent-faint">Save your changes before publishing, or publish to save and release together.</span>
                    </Show>
                  </div>
                </Card>

                <Show when={released()}>
                  {(value) => (
                    <Card title={`Released v${value().version}`} description="Copy these into your packaging pipeline or MDM.">
                      <div class="ent-stack" style={{ gap: "10px" }}>
                        <div>
                          <div class="ent-label" style={{ "margin-bottom": "4px" }}>Public manifest</div>
                          <CopyField value={manifestUrl(value().slug)} />
                        </div>
                        <div>
                          <div class="ent-label" style={{ "margin-bottom": "6px" }}>Client downloads</div>
                          <div class="ent-stack" style={{ gap: "6px" }}>
                            <For each={value().deployment.platforms}>
                              {(platform) => <CopyField value={installerUrl(value().slug, platform)} />}
                            </For>
                          </div>
                        </div>
                      </div>
                    </Card>
                  )}
                </Show>

                <Show when={published() && released() === undefined}>
                  <Card title="Live endpoints" description="This build is already published.">
                    <div class="ent-stack" style={{ gap: "10px" }}>
                      <CopyField value={manifestUrl(draft()!.slug)} />
                      <div class="ent-small ent-faint">
                        Last published {relative(draft()!.publishedAt)}. Installed clients read this manifest on
                        launch.
                      </div>
                    </div>
                  </Card>
                </Show>
              </div>
            </Show>
          </div>

          <aside class="ent-builder-preview">
            <div class="ent-stack">
              <div class="dist-preview">
                <div class="dist-preview-label">
                  <span class="ent-label">Client preview</span>
                  <span class="ent-small ent-faint">Sign-in screen</span>
                </div>
                <BuildPreview distribution={draft()!} />
              </div>
              <Card title="Build summary" padded>
                <div class="ent-stack" style={{ gap: "2px" }}>
                  <Definition label="Sign-in">
                    <span class="ent-row" style={{ gap: "4px" }}>
                      <Icon name="shield" size="small" /> SSO only
                    </span>
                  </Definition>
                  <Definition label="Methods">{draft()!.auth.methods.join(", ")}</Definition>
                  <Definition label="Session">{number(draft()!.auth.sessionHours)} hours</Definition>
                  <Definition label="Capabilities">{FEATURES.filter((feature) => draft()!.features[feature.key]).length} on</Definition>
                  <Definition label="Platforms">{draft()!.deployment.platforms.length} of 5</Definition>
                  <Definition label="Token ceiling">
                    {draft()!.limits.monthlyTokensPerUser === 0 ? "Unlimited" : number(draft()!.limits.monthlyTokensPerUser)}
                  </Definition>
                  <Definition label="Spend ceiling">
                    {draft()!.limits.monthlySpendPerUserUsd === 0
                      ? "Unlimited"
                      : `$${draft()!.limits.monthlySpendPerUserUsd.toFixed(2)}`}
                  </Definition>
                  <Definition label="Update channel">{draft()!.update.channel}</Definition>
                </div>
              </Card>
              <Show when={!canWrite()}>
                <InlineNote tone="warning" icon="shield">
                  Your role can inspect this build but not change it.
                </InlineNote>
              </Show>
            </div>
          </aside>
        </div>
      </Show>

      <Modal
        open={publishing()}
        onClose={() => setPublishing(false)}
        title={released() === undefined ? `Publish ${draft()?.name ?? "build"}` : "Build published"}
        description={
          released() === undefined
            ? "Publishing makes the manifest public and writes an audit event. Installed clients pick it up on their next launch."
            : "Copy the manifest and enrollment links into your packaging pipeline or MDM."
        }
        footer={
          <Show
            when={released()}
            fallback={
              <>
                <Button variant="ghost" onClick={() => setPublishing(false)}>
                  Cancel
                </Button>
                <Button variant="primary" loading={publishBusy()} onClick={() => void publish()}>
                  Publish
                </Button>
              </>
            }
          >
            <Button variant="primary" onClick={() => setPublishing(false)}>
              Done
            </Button>
          </Show>
        }
      >
        <Show
          when={released()}
          fallback={
            <>
              <Field label="Version" required hint="Semantic version. Installed clients compare against this.">
                <Input value={publishVersion()} onInput={setPublishVersion} placeholder="1.0.0" />
              </Field>
              <Field label="Release notes" hint="Shown in the update prompt.">
                <Textarea value={publishNotes()} onInput={setPublishNotes} rows={4} />
              </Field>
              <InlineNote tone="accent" icon="eye">
                The manifest will be served at <code>{manifestUrl(draft()?.slug ?? "")}</code>.
              </InlineNote>
              <Show when={publishError()}>
                <InlineNote tone="danger" icon="warning">
                  {publishError()}
                </InlineNote>
              </Show>
            </>
          }
        >
          {(value) => (
            <div class="ent-stack">
              <InlineNote tone="success" icon="check">
                {value().name} v{value().version} is live. Installed clients read this manifest on their next
                launch.
              </InlineNote>
              <div>
                <div class="ent-label" style={{ "margin-bottom": "4px" }}>
                  Public manifest
                </div>
                <CopyField value={manifestUrl(value().slug)} />
              </div>
              <div>
                <div class="ent-label" style={{ "margin-bottom": "6px" }}>
                  Enrollment bundles
                </div>
                <div class="ent-stack" style={{ gap: "6px" }}>
                  <For each={value().deployment.platforms}>
                    {(platform) => <CopyField value={`${enrollmentBase(value().slug)}/${platform}`} />}
                  </For>
                </div>
                <Show when={value().deployment.platforms.length === 0}>
                  <InlineNote tone="warning" icon="warning">
                    No platforms are selected for this build. Add platforms before distributing it.
                  </InlineNote>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </Modal>

      <Modal
        open={logsFor() !== undefined}
        onClose={() => setLogsFor(undefined)}
        title={`Build log · ${openLog()?.platform ?? ""}`}
        description={openLog()?.error ?? `Version ${openLog()?.version ?? ""} · ${openLog()?.status ?? "queued"}`}
        width="wide"
        footer={
          <Button variant="secondary" onClick={() => setLogsFor(undefined)}>
            Close
          </Button>
        }
      >
        <Show when={openLog()}>
          {(release) => (
            <div class="ent-stack">
              <div class="ent-grid ent-grid-3">
                <Definition label="Status">{release().status}</Definition>
                <Definition label="Artifact">{release().filename ?? "None yet"}</Definition>
                <Definition label="SHA-256">
                  <code>{release().sha256 === undefined ? "None yet" : release().sha256!.slice(0, 24)}</code>
                </Definition>
              </div>
              <pre class="dist-build-log">
                {release().log.length === 0 ? "Waiting for the build to report output." : release().log.join("\n")}
              </pre>
            </div>
          )}
        </Show>
      </Modal>
    </div>
  )
}
