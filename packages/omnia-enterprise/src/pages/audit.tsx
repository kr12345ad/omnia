import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { api, download } from "@/lib/api"
import { dateTime, number, relative, titleCase } from "@/lib/format"
import { useSession, useToast } from "@/state"
import {
  Button,
  Card,
  CopyField,
  Definition,
  EmptyState,
  IconButton,
  InlineNote,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Stat,
  Tag,
} from "@/components/ui"
import type { AuditEvent } from "@/types"
import "./governance.css"

interface ActionStyle {
  title: string
  tone: "neutral" | "success" | "warning" | "danger"
  icon:
    | "status"
    | "users"
    | "group"
    | "subagent"
    | "shield"
    | "download"
    | "review"
    | "link"
    | "server"
    | "sliders"
    | "archive"
    | "task"
    | "models"
    | "edit"
    | "trash"
    | "terminal"
    | "warning"
    | "cloud-upload"
}

const ACTIONS: Record<string, ActionStyle> = {
  "org.setup": { title: "Deployment created", tone: "success", icon: "status" },
  "org.updated": { title: "Organization updated", tone: "neutral", icon: "sliders" },
  "org.asset_uploaded": { title: "Uploaded a branding asset", tone: "neutral", icon: "cloud-upload" },
  "org.asset_deleted": { title: "Removed a branding asset", tone: "warning", icon: "trash" },
  "user.invited": { title: "Invited a person", tone: "neutral", icon: "users" },
  "user.created": { title: "Created a person", tone: "success", icon: "users" },
  "user.updated": { title: "Updated a person", tone: "neutral", icon: "edit" },
  "user.suspended": { title: "Suspended a person", tone: "warning", icon: "shield" },
  "user.reactivated": { title: "Reactivated a person", tone: "success", icon: "users" },
  "user.deleted": { title: "Deleted a person", tone: "danger", icon: "trash" },
  "user.password_reset": { title: "Reset a password", tone: "warning", icon: "shield" },
  "user.login": { title: "Console sign-in", tone: "success", icon: "status" },
  "user.login_failed": { title: "Failed console sign-in", tone: "danger", icon: "warning" },
  "user.logout": { title: "Signed out", tone: "neutral", icon: "status" },
  "group.created": { title: "Created a group", tone: "success", icon: "group" },
  "group.updated": { title: "Updated a group", tone: "neutral", icon: "group" },
  "group.deleted": { title: "Deleted a group", tone: "danger", icon: "trash" },
  "distribution.created": { title: "Created a client build", tone: "neutral", icon: "download" },
  "distribution.updated": { title: "Updated a client build", tone: "neutral", icon: "edit" },
  "distribution.published": { title: "Published a client build", tone: "success", icon: "download" },
  "distribution.deleted": { title: "Deleted a client build", tone: "danger", icon: "trash" },
  "policy.updated": { title: "Changed policies", tone: "warning", icon: "shield" },
  "license.activated": { title: "Activated a license", tone: "success", icon: "shield" },
  "license.rejected": { title: "Rejected a license", tone: "danger", icon: "warning" },
  "scim.token_rotated": { title: "Rotated the SCIM token", tone: "warning", icon: "link" },
  "scim.user_created": { title: "SCIM provisioned a person", tone: "neutral", icon: "server" },
  "scim.user_updated": { title: "SCIM updated a person", tone: "neutral", icon: "server" },
  "integration.updated": { title: "Updated integrations", tone: "neutral", icon: "link" },
  "client.login": { title: "Client sign-in", tone: "success", icon: "status" },
  "client.login_failed": { title: "Failed client sign-in", tone: "danger", icon: "warning" },
  "export.downloaded": { title: "Downloaded an export", tone: "neutral", icon: "archive" },
}

const KNOWN_ACTIONS = Object.keys(ACTIONS)

function styleOf(action: string): ActionStyle {
  return ACTIONS[action] ?? { title: titleCase(action), tone: "neutral", icon: "review" }
}

function actorOf(event: AuditEvent): string {
  return event.actorEmail ?? (event.actorId === undefined ? "System" : event.actorId)
}

export function AuditPage() {
  const session = useSession()
  const toast = useToast()
  const [events, setEvents] = createSignal<AuditEvent[]>([])
  const [total, setTotal] = createSignal(0)
  const [action, setAction] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [loadingOlder, setLoadingOlder] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [more, setMore] = createSignal(false)
  const [detail, setDetail] = createSignal<AuditEvent | null>(null)

  const load = async (older: boolean) => {
    const oldest = older ? events().at(-1) : undefined
    if (older) setLoadingOlder(true)
    else setLoading(true)
    setError(undefined)
    try {
      const response = await api.audit({
        limit: 50,
        ...(action().length === 0 ? {} : { action: action() }),
        ...(oldest === undefined ? {} : { before: oldest.at + 1 }),
      })
      const incoming = response.events
      if (older) {
        const seen = new Set(events().map((event) => event.id))
        setEvents([...events(), ...incoming.filter((event) => !seen.has(event.id))])
      } else {
        setEvents(incoming)
        setTotal(response.total)
      }
      setMore(incoming.length >= 50)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The audit log could not be loaded.")
    } finally {
      setLoading(false)
      setLoadingOlder(false)
    }
  }

  onMount(() => {
    void load(false)
  })

  const options = createMemo(() => {
    const distinct = [...new Set(events().map((event) => event.action))].filter((entry) => !KNOWN_ACTIONS.includes(entry))
    return [
      { value: "", label: "All actions" },
      ...[...KNOWN_ACTIONS, ...distinct].map((value) => ({ value, label: styleOf(value).title })),
    ]
  })

  const exportLog = () => {
    if (!session.can("audit:export")) {
      toast.push("Your role cannot export the audit log.", "error")
      return
    }
    download("/audit/export")
    toast.push("Preparing the audit export.", "info")
  }

  const retention = () => session.session()!.organization.policies.audit.retentionDays

  return (
    <div class="ent-page">
      <PageHeader
        kicker="Security"
        title="Audit log"
        description="Every privileged action on this deployment: sign-ins, role changes, client releases, policy edits, license changes and exports. Records are written by the server, not the browser."
        actions={
          <>
            <Button variant="secondary" icon="reset" onClick={() => void load(false)} disabled={loading()}>
              Refresh
            </Button>
            <Show when={session.can("audit:export")}>
              <Button variant="primary" icon="download" onClick={exportLog}>
                Export CSV
              </Button>
            </Show>
          </>
        }
      />

      <div class="ent-grid ent-grid-3" style={{ "margin-bottom": "14px" }}>
        <Stat label="Recorded events" value={number(total())} icon="review" hint="All events on this server" />
        <Stat label="Loaded" value={number(events().length)} icon="status" hint={more() ? "More available" : "Newest first"} />
        <Stat
          label="Retention"
          value={`${number(retention())} days`}
          icon="archive"
          hint="Set in Policies → Audit trail"
        />
      </div>

      <Show when={error()}>
        <div style={{ "margin-bottom": "14px" }}>
          <InlineNote tone="danger" icon="warning">
            {error()}
          </InlineNote>
        </div>
      </Show>

      <Card padded={false}>
        <div class="ent-toolbar ent-audit-toolbar">
          <span class="ent-label">Action</span>
          <div class="ent-audit-filter">
            <Select
              value={action()}
              onChange={(value) => {
                setAction(value)
                setEvents([])
                void load(false)
              }}
              options={options()}
            />
          </div>
          <span class="ent-topbar-spacer" />
          <Tag tone="muted">{number(events().length)} shown</Tag>
        </div>

        <Show when={loading()}>
          <div style={{ padding: "14px" }}>
            <div class="ent-stack">
              <Skeleton height={38} />
              <Skeleton height={38} />
              <Skeleton height={38} />
              <Skeleton height={38} />
            </div>
          </div>
        </Show>

        <Show when={!loading() && events().length === 0}>
          <EmptyState
            icon="review"
            title="No events match this filter"
            description="Try another action, or clear the filter. Sign-ins and policy changes appear here as they happen."
            action={
              <Show when={action().length > 0}>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAction("")
                    void load(false)
                  }}
                >
                  Clear filter
                </Button>
              </Show>
            }
          />
        </Show>

        <Show when={!loading() && events().length > 0}>
          <div class="ent-table-wrap">
            <table class="ent-table ent-audit-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Target</th>
                  <th>Address</th>
                  <th data-align="right">Details</th>
                </tr>
              </thead>
              <tbody>
                <For each={events()}>
                  {(event) => {
                    const style = styleOf(event.action)
                    return (
                      <tr>
                        <td>
                          <div class="ent-audit-time">
                            <span>{dateTime(event.at)}</span>
                            <span>{relative(event.at)}</span>
                          </div>
                        </td>
                        <td>
                          <div class="ent-audit-action">
                            <span class="ent-audit-action-icon" data-tone={style.tone}>
                              <Icon name={style.icon} size="small" />
                            </span>
                            <span class="ent-audit-action-text">
                              <strong>{style.title}</strong>
                              <span>{event.action}</span>
                            </span>
                          </div>
                        </td>
                        <td>
                          <span class="ent-truncate ent-audit-actor" title={actorOf(event)}>
                            {actorOf(event)}
                          </span>
                        </td>
                        <td>
                          <span class="ent-truncate ent-audit-target" title={event.target ?? undefined}>
                            {event.target ?? "—"}
                          </span>
                        </td>
                        <td class="ent-mono">{event.ip ?? "—"}</td>
                        <td data-align="right">
                          <div class="ent-row-actions">
                            <IconButton icon="eye" label={`Details for ${style.title}`} onClick={() => setDetail(event)} />
                          </div>
                        </td>
                      </tr>
                    )
                  }}
                </For>
              </tbody>
            </table>
          </div>

          <div class="ent-pagination">
            <span>
              Showing {number(events().length)} of {number(total())} total events
              {action().length > 0 ? ` · filtered to ${styleOf(action()).title}` : ""}
            </span>
            <Button
              size="small"
              variant="secondary"
              loading={loadingOlder()}
              disabled={!more()}
              onClick={() => void load(true)}
            >
              {more() ? "Load older" : "End of log"}
            </Button>
          </div>
        </Show>
      </Card>

      <div style={{ "margin-top": "14px" }}>
        <InlineNote icon="review">
          Records are kept for {number(retention())} days by policy. Exporting the log is itself recorded as an event.
          This page shows the server's own trail; it does not claim a cryptographic chain verification.
        </InlineNote>
      </div>

      <Modal
        open={detail() !== null}
        onClose={() => setDetail(null)}
        title={detail() === null ? "Event" : styleOf(detail()!.action).title}
        description={detail() === null ? undefined : dateTime(detail()!.at)}
        width="wide"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDetail(null)}>
              Close
            </Button>
          </>
        }
      >
        <Show when={detail()}>
          {(eventAccessor) => {
            const event = () => eventAccessor()
            return (
              <div class="ent-stack">
                <div class="ent-audit-detail-grid">
                  <Definition label="Event ID">
                    <span class="ent-mono">{event().id}</span>
                  </Definition>
                  <Definition label="Action">
                    <span class="ent-mono">{event().action}</span>
                  </Definition>
                  <Definition label="Actor">{actorOf(event())}</Definition>
                  <Definition label="Target">{event().target ?? "—"}</Definition>
                  <Definition label="Address">{event().ip ?? "—"}</Definition>
                  <Definition label="When">
                    {dateTime(event().at)} · {relative(event().at)}
                  </Definition>
                  <div class="ent-span-2">
                    <Definition label="User agent">{event().userAgent ?? "—"}</Definition>
                  </div>
                </div>
                <Show when={event().metadata !== undefined}>
                  <div>
                    <div class="ent-label" style={{ "margin-bottom": "6px" }}>
                      Metadata
                    </div>
                    <pre class="ent-audit-json">{JSON.stringify(event().metadata, null, 2)}</pre>
                  </div>
                </Show>
                <div>
                  <div class="ent-label" style={{ "margin-bottom": "6px" }}>
                    Event reference
                  </div>
                  <CopyField value={event().id} />
                </div>
              </div>
            )
          }}
        </Show>
      </Modal>
    </div>
  )
}
