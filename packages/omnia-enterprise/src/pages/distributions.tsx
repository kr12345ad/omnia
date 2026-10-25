import { For, Show, createMemo, createResource, createSignal, onMount } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { api } from "@/lib/api"
import { number, relative, date } from "@/lib/format"
import { navigate, routeQuery } from "@/lib/router"
import { useSession, useToast } from "@/state"
import {
  Button,
  Card,
  CopyField,
  Field,
  IconButton,
  InlineNote,
  Input,
  Modal,
  PageHeader,
  Skeleton,
  Stat,
  Tag,
  Textarea,
} from "@/components/ui"
import type { Distribution } from "@/types"
import "./distributions.css"

const STATUS_TONE = { draft: "warning", published: "success", archived: "muted" } as const

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function manifestUrl(slug: string): string {
  return `${location.origin}/v1/enterprise/public/client/${encodeURIComponent(slug)}/manifest`
}

function enrollmentUrl(slug: string): string {
  return `${location.origin}/v1/enterprise/public/client/${encodeURIComponent(slug)}/download`
}

function BuildMark(props: { distribution: Distribution; size?: "small" | "large" }) {
  const initial = () => (props.distribution.branding.shortName || props.distribution.name).slice(0, 1).toUpperCase()
  return (
    <span
      class="dist-mark"
      data-size={props.size ?? "large"}
      style={{
        background: `linear-gradient(135deg, ${props.distribution.branding.primaryColor}, ${props.distribution.branding.accentColor})`,
      }}
    >
      <Show when={props.distribution.branding.logoUrl || props.distribution.branding.iconUrl} fallback={initial()}>
        {(url) => <img src={url()} alt="" />}
      </Show>
    </span>
  )
}

function platformLabels(distribution: Distribution): string {
  if (distribution.deployment.platforms.length === 0) return "No platforms"
  if (distribution.deployment.platforms.length === 5) return "All platforms"
  return distribution.deployment.platforms
    .map((platform) => platform.replace("macos", "mac").replace("windows", "win").replace("linux", "linux"))
    .join(" · ")
}

export function DistributionsPage() {
  const session = useSession()
  const toast = useToast()
  const [list, { refetch }] = createResource(() => api.distributions())
  const [creating, setCreating] = createSignal(false)
  const [name, setName] = createSignal("")
  const [slug, setSlug] = createSignal("")
  const [autoSlug, setAutoSlug] = createSignal(true)
  const [description, setDescription] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [formError, setFormError] = createSignal<string>()
  const [deleting, setDeleting] = createSignal<Distribution>()
  const [deleteBusy, setDeleteBusy] = createSignal(false)

  const items = () => list()?.distributions ?? []
  const published = createMemo(() => items().filter((item) => item.status === "published"))
  const drafts = createMemo(() => items().filter((item) => item.status === "draft"))
  const platforms = createMemo(() => new Set(items().flatMap((item) => item.deployment.platforms)).size)

  const openCreate = () => {
    setName("")
    setSlug("")
    setAutoSlug(true)
    setDescription("")
    setFormError(undefined)
    setCreating(true)
  }

  onMount(() => {
    if (routeQuery().get("new") === "1" && session.can("distributions:write")) openCreate()
  })

  const create = async () => {
    if (name().trim().length === 0) {
      setFormError("Give the build a name.")
      return
    }
    setBusy(true)
    setFormError(undefined)
    try {
      const result = await api.createDistribution({
        name: name().trim(),
        ...(slug().trim().length === 0 ? {} : { slug: slug().trim() }),
        ...(description().trim().length === 0 ? {} : { description: description().trim() }),
      })
      setCreating(false)
      toast.push("Client build created. Finish its branding and publish when ready.", "success")
      navigate(`/distributions/${result.distribution.id}`)
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not create the build.")
    } finally {
      setBusy(false)
    }
  }

  const duplicate = async (distribution: Distribution) => {
    try {
      const result = await api.duplicateDistribution(distribution.id)
      await refetch()
      toast.push(`Copied ${distribution.name}.`, "success")
      navigate(`/distributions/${result.distribution.id}`)
    } catch (cause) {
      toast.push(cause instanceof Error ? cause.message : "Could not duplicate the build.", "error")
    }
  }

  const remove = async () => {
    const target = deleting()
    if (target === undefined) return
    setDeleteBusy(true)
    try {
      await api.deleteDistribution(target.id)
      setDeleting(undefined)
      await refetch()
      toast.push(`${target.name} was deleted. Enrolled clients stop receiving its manifest.`, "success")
    } catch (cause) {
      toast.push(cause instanceof Error ? cause.message : "Could not delete the build.", "error")
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div class="ent-page">
      <PageHeader
        kicker="Client distribution"
        title="Client builds"
        description="Ship a client that is unmistakably yours: your name, your colors, your models, hard limits and single sign-on that only your people can use. Every build is served from this server."
        actions={
          <Show when={session.can("distributions:write")}>
            <Button variant="primary" icon="plus" onClick={openCreate}>
              New build
            </Button>
          </Show>
        }
      />

      <Show when={list.error}>
        <InlineNote tone="danger" icon="warning">
          {list.error instanceof Error ? list.error.message : "Could not load client builds."}
        </InlineNote>
      </Show>

      <div class="ent-grid ent-grid-4" style={{ "margin-bottom": "14px" }}>
        <Stat label="Builds" value={list() ? number(items().length) : <Skeleton height={26} width="40px" />} icon="download" hint="Drafts and published" />
        <Stat
          label="Published"
          value={list() ? number(published().length) : <Skeleton height={26} width="40px" />}
          icon="check"
          hint={published().length > 0 ? "Serving manifests now" : "Nothing is live yet"}
        />
        <Stat
          label="Drafts"
          value={list() ? number(drafts().length) : <Skeleton height={26} width="40px" />}
          icon="edit"
          hint="Not visible to clients"
        />
        <Stat
          label="Platforms"
          value={list() ? `${number(platforms())} / 5` : <Skeleton height={26} width="50px" />}
          icon="server"
          hint="Covered across builds"
        />
      </div>

      <Show when={published().length === 0 && items().length > 0}>
        <div style={{ "margin-bottom": "14px" }}>
          <InlineNote tone="warning" icon="warning">
            No build is published yet. Drafts cannot be downloaded or enrolled. Open a build, finish its
            configuration, then press <strong>Publish</strong>.
          </InlineNote>
        </div>
      </Show>

      <Show
        when={list() !== undefined}
        fallback={
          <div class="ent-grid ent-grid-2">
            <Skeleton height={230} />
            <Skeleton height={230} />
          </div>
        }
      >
        <Show
          when={items().length > 0}
          fallback={
            <Card>
              <div class="dist-empty">
                <span class="ent-empty-icon">
                  <Icon name="download" />
                </span>
                <h3>Build the client your company signs into</h3>
                <p>
                  A build is a self-contained bundle: branding, SSO-only authentication, feature switches,
                  per-person limits and an update channel. Publish one build or several — one per business unit,
                  region or device fleet.
                </p>
                <div class="dist-empty-steps">
                  <div>
                    <span class="ent-label">1 · Create</span>
                    <p>Name it. We generate a stable URL that enrolled clients read at startup.</p>
                  </div>
                  <div>
                    <span class="ent-label">2 · Configure</span>
                    <p>Set sign-in copy, domains, models, tools and hard per-person limits.</p>
                  </div>
                  <div>
                    <span class="ent-label">3 · Publish</span>
                    <p>Pin a version. Point your packaging pipeline at the manifest URL.</p>
                  </div>
                </div>
                <Show when={session.can("distributions:write")}>
                  <Button variant="primary" icon="plus" onClick={openCreate}>
                    Create the first build
                  </Button>
                </Show>
              </div>
            </Card>
          }
        >
          <div class="ent-grid ent-grid-2">
            <For each={items()}>
              {(distribution) => (
                <article class="dist-card">
                  <div
                    class="dist-card-band"
                    style={{
                      background: `linear-gradient(135deg, ${distribution.branding.primaryColor}, ${distribution.branding.accentColor})`,
                    }}
                  >
                    <BuildMark distribution={distribution} />
                    <Tag tone={STATUS_TONE[distribution.status]} dot>
                      {distribution.status}
                    </Tag>
                  </div>
                  <div class="dist-card-body">
                    <div class="dist-card-heading">
                      <h3 class="dist-card-title">{distribution.name}</h3>
                      <div class="dist-card-slug">
                        <span class="dist-card-path">/{distribution.slug}</span>
                        <span class="dist-card-version">v{distribution.version}</span>
                      </div>
                    </div>
                    <p class="dist-card-description">
                      {distribution.description.trim().length > 0
                        ? distribution.description
                        : distribution.branding.tagline || "No description yet."}
                    </p>
                    <div class="dist-card-meta">
                      <div>
                        <span class="ent-label">Sign-in</span>
                        <span class="dist-meta-value">
                          <Icon name="shield" size="small" /> SSO only
                        </span>
                      </div>
                      <div>
                        <span class="ent-label">Platforms</span>
                        <span class="dist-meta-value">{platformLabels(distribution)}</span>
                      </div>
                      <div>
                        <span class="ent-label">Updated</span>
                        <span class="dist-meta-value">{relative(distribution.updatedAt)}</span>
                      </div>
                      <div>
                        <span class="ent-label">Published</span>
                        <span class="dist-meta-value">
                          {distribution.publishedAt === undefined ? "Not yet" : date(distribution.publishedAt)}
                        </span>
                      </div>
                    </div>
                    <Show when={distribution.status === "published"}>
                      <div class="dist-card-url">
                        <code title={manifestUrl(distribution.slug)}>{manifestUrl(distribution.slug)}</code>
                      </div>
                      <div class="dist-enrollment-hint">{enrollmentUrl(distribution.slug)}/&lt;platform&gt;</div>
                    </Show>
                  </div>
                  <div class="dist-card-foot">
                    <Button size="small" variant="secondary" icon="arrow-right" onClick={() => navigate(`/distributions/${distribution.id}`)}>
                      Open build
                    </Button>
                    <span class="ent-topbar-spacer" />
                    <Show when={session.can("distributions:write")}>
                      <IconButton icon="copy" label={`Duplicate ${distribution.name}`} onClick={() => void duplicate(distribution)} />
                      <IconButton
                        icon="trash"
                        label={`Delete ${distribution.name}`}
                        variant="danger"
                        onClick={() => setDeleting(distribution)}
                      />
                    </Show>
                  </div>
                </article>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <div style={{ "margin-top": "18px" }}>
        <Card title="What a build controls" description="One manifest, enforced before a client can work.">
          <div class="ent-grid ent-grid-3">
            <div>
              <div class="ent-label">Identity</div>
              <p class="ent-small ent-muted" style={{ margin: "4px 0 0" }}>
                Work email or employee ID, optional OIDC/SAML, approved domains and session length. Social
                login is not part of the format.
              </p>
            </div>
            <div>
              <div class="ent-label">Capability</div>
              <p class="ent-small ent-muted" style={{ margin: "4px 0 0" }}>
                Computer control, browser, vision, scheduled runs, chat channels, memory and tools can be
                switched off per build.
              </p>
            </div>
            <div>
              <div class="ent-label">Spend</div>
              <p class="ent-small ent-muted" style={{ margin: "4px 0 0" }}>
                Token and dollar ceilings per person, computer counts, concurrency and context limits are
                shipped inside the manifest.
              </p>
            </div>
          </div>
        </Card>
      </div>

      <Modal
        open={creating()}
        onClose={() => setCreating(false)}
        title="New client build"
        description="Create the shell first. Branding, authentication and limits are configured in the builder."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy()} onClick={() => void create()}>
              Create build
            </Button>
          </>
        }
      >
        <Field label="Build name" required hint="Shown on the sign-in screen and in the update prompt.">
          <Input
            value={name()}
            onInput={(value) => {
              setName(value)
              if (autoSlug()) setSlug(slugify(value))
            }}
            placeholder="Acme Omnia"
            autofocus
          />
        </Field>
        <Field label="Manifest URL" hint="Stable identifier. It appears in the public manifest and enrollment links.">
          <div class="dist-slug-input">
            <span>/client/</span>
            <Input
              value={slug()}
              onInput={(value) => {
                setAutoSlug(false)
                setSlug(slugify(value))
              }}
              placeholder="acme"
            />
          </div>
        </Field>
        <Field label="Description" hint="Internal note for other administrators. Not shown to end users.">
          <Textarea value={description()} onInput={setDescription} rows={3} />
        </Field>
        <Show when={formError()}>
          <InlineNote tone="danger" icon="warning">
            {formError()}
          </InlineNote>
        </Show>
      </Modal>

      <Modal
        open={deleting() !== undefined}
        onClose={() => setDeleting(undefined)}
        title={`Delete ${deleting()?.name ?? "this build"}?`}
        description="Published clients will stop receiving a manifest on their next launch. Existing installations are not removed from devices."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(undefined)}>
              Keep build
            </Button>
            <Button variant="danger" loading={deleteBusy()} onClick={() => void remove()}>
              Delete permanently
            </Button>
          </>
        }
      >
        <InlineNote tone="warning" icon="warning">
          This cannot be undone. Usage events already recorded keep the distribution's id, but the manifest and
          enrollment links stop working immediately.
        </InlineNote>
        <Show when={deleting()}>
          {(distribution) => <CopyField value={manifestUrl(distribution().slug)} />}
        </Show>
      </Modal>

      <Show when={items().some((item) => item.status === "published")}>
        <div style={{ "margin-top": "14px" }}>
          <Card title="Enrollment endpoints" description="Give these to your MDM, packaging pipeline or people.">
            <div class="ent-stack" style={{ gap: "10px" }}>
              <For each={published()}>
                {(distribution) => (
                  <div>
                    <div class="ent-row" style={{ "margin-bottom": "4px" }}>
                      <Tag tone="success">{distribution.name}</Tag>
                      <span class="ent-small ent-faint">v{distribution.version}</span>
                    </div>
                    <CopyField value={manifestUrl(distribution.slug)} />
                    <div class="dist-enrollment-hint">{enrollmentUrl(distribution.slug)}/&lt;platform&gt;</div>
                  </div>
                )}
              </For>
            </div>
          </Card>
        </div>
      </Show>
    </div>
  )
}
