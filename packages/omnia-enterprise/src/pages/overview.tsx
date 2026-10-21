import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { api, download } from "@/lib/api"
import { compact, number, percent, relative, shortDate, usd } from "@/lib/format"
import { href, navigate } from "@/lib/router"
import { useSession } from "@/state"
import { AreaChart, BarChart, PALETTE } from "@/components/charts"
import {
  Button,
  Card,
  EmptyState,
  InlineNote,
  PageHeader,
  Progress,
  Skeleton,
  Stat,
  Tag,
} from "@/components/ui"
import type { AuditEvent, UsageBucket } from "@/types"
import "./analytics.css"

const RANGES = [7, 30, 90] as const

function auditLabel(action: string): { title: string; tone: "neutral" | "success" | "warning" | "danger" } {
  switch (action) {
    case "user.login":
      return { title: "Signed in", tone: "success" }
    case "user.login_failed":
      return { title: "Failed sign-in", tone: "danger" }
    case "user.invited":
      return { title: "Invited a teammate", tone: "neutral" }
    case "user.created":
      return { title: "Created a user", tone: "success" }
    case "user.updated":
      return { title: "Updated a user", tone: "neutral" }
    case "user.suspended":
      return { title: "Suspended a user", tone: "warning" }
    case "user.password_reset":
      return { title: "Reset a password", tone: "warning" }
    case "distribution.published":
      return { title: "Published a client build", tone: "success" }
    case "distribution.created":
      return { title: "Created a client build", tone: "neutral" }
    case "policy.updated":
      return { title: "Changed a policy", tone: "warning" }
    case "license.activated":
      return { title: "Activated a license", tone: "success" }
    case "license.rejected":
      return { title: "Rejected a license", tone: "danger" }
    case "client.login":
      return { title: "Client sign-in", tone: "success" }
    case "org.setup":
      return { title: "Deployment created", tone: "success" }
    case "org.asset_uploaded":
      return { title: "Uploaded a branding asset", tone: "neutral" }
    case "org.asset_deleted":
      return { title: "Removed a branding asset", tone: "warning" }
    case "scim.user_created":
      return { title: "Provisioned a user with SCIM", tone: "neutral" }
    case "export.downloaded":
      return { title: "Exported a report", tone: "neutral" }
    default:
      return { title: action.replace(/[._]/g, " "), tone: "neutral" }
  }
}

function auditActor(event: AuditEvent): string {
  return event.actorEmail ?? "System"
}

function sum(bucket: UsageBucket[], field: "requests" | "inputTokens" | "outputTokens" | "costUsd", from = 0, to = bucket.length): number {
  return bucket.slice(from, to).reduce((total, entry) => total + entry[field], 0)
}

function trend(buckets: UsageBucket[], field: "requests" | "costUsd"): { value: string; direction: "up" | "down" | "flat"; good: boolean } | undefined {
  const usable = buckets.filter((bucket) => bucket.requests > 0 || bucket.costUsd > 0)
  if (usable.length < 4) return undefined
  const half = Math.floor(buckets.length / 2)
  const previous = sum(buckets, field, 0, half)
  const current = sum(buckets, field, half)
  if (previous === 0) return current === 0 ? undefined : { value: "new", direction: "up", good: field === "costUsd" ? false : true }
  const change = ((current - previous) / previous) * 100
  return {
    value: `${Math.abs(change).toFixed(0)}%`,
    direction: change > 2 ? "up" : change < -2 ? "down" : "flat",
    good: field === "costUsd" ? change <= 0 : change >= 0,
  }
}

export function OverviewPage() {
  const session = useSession()
  const [range, setRange] = createSignal<(typeof RANGES)[number]>(30)
  const [summary] = createResource(range, (days) => api.summary(days))
  const [insights] = createResource(range, (days) => api.usageInsights(days).catch(() => undefined))
  const org = () => session.session()!.organization
  const data = () => summary()?.summary
  const usage = () => data()?.usage
  const trialDays = () => data()?.trial.daysLeft ?? Math.max(0, Math.ceil((org().trialEndsAt - Date.now()) / 86_400_000))

  const spendSeries = createMemo(() =>
    (data()?.spendByDay ?? []).map((bucket) => ({
      key: shortDate(new Date(`${bucket.key}T12:00:00Z`).getTime()),
      label: shortDate(new Date(`${bucket.key}T12:00:00Z`).getTime()),
      value: bucket.costUsd,
    })),
  )
  const requestSeries = createMemo(() =>
    (data()?.spendByDay ?? []).map((bucket) => ({
      key: bucket.key,
      label: shortDate(new Date(`${bucket.key}T12:00:00Z`).getTime()),
      value: bucket.requests,
    })),
  )
  const modelTotal = createMemo(() => sum(data()?.usageByModel ?? [], "costUsd"))
  const modelBars = createMemo(() =>
    (data()?.usageByModel ?? []).map((bucket) => ({ key: bucket.key, label: bucket.key, value: bucket.costUsd })),
  )
  const toolTotal = createMemo(() => sum(data()?.topTools ?? [], "requests"))
  const readiness = createMemo(() => {
    const summaryValue = data()
    const policies = org().policies
    return [
      {
        label: "Owner account created",
        detail: "The first administrator owns the deployment.",
        done: summaryValue !== undefined,
        path: "/settings",
      },
      {
        label: "Client build published",
        detail: "People need a build before they can sign in.",
        done: (summaryValue?.distributions.published ?? 0) > 0,
        path: "/distributions",
      },
      {
        label: "Model access narrowed",
        detail: "Allowlist or block models your business does not use.",
        done: policies.model.models.length > 0,
        path: "/policies",
      },
      {
        label: "Session policy reviewed",
        detail: "Set session length, MFA and IP allowlists.",
        done: policies.sessionHours <= 24 && (policies.requireMfa || policies.ipAllowlist.length > 0),
        path: "/policies",
      },
      {
        label: "License installed",
        detail: "Business or Enterprise, verified offline.",
        done: org().license.valid,
        path: "/settings",
      },
    ]
  })
  const readinessDone = createMemo(() => readiness().filter((item) => item.done).length)

  return (
    <div class="ent-page">
      <PageHeader
        kicker="Enterprise workspace"
        title={`Good to see you, ${session.session()!.user.name.split(" ")[0]}`}
        description="The people, client builds, policies and spend that make this deployment yours. Everything here is recorded on your server."
        actions={
          <>
            <div class="ent-tabs analytics-range">
              <For each={RANGES}>
                {(days) => (
                  <button
                    type="button"
                    class="ent-button"
                    data-size="small"
                    data-variant={range() === days ? "secondary" : "ghost"}
                    onClick={() => setRange(days)}
                  >
                    {days}d
                  </button>
                )}
              </For>
            </div>
            <Button variant="secondary" icon="download" onClick={() => download("/usage/export")}>
              Export
            </Button>
            <Show when={session.can("users:invite")}>
              <Button variant="primary" icon="plus" onClick={() => navigate("/users?invite=1")}>
                Invite people
              </Button>
            </Show>
          </>
        }
      />

      <Show when={org().plan === "expired"}>
        <div class="analytics-section">
          <InlineNote tone="danger" icon="warning">
            The trial ended and no license is installed. People can still sign in, but changes and new client
            builds are blocked. <a href={href("/settings")}><strong>Activate a license</strong></a>.
          </InlineNote>
        </div>
      </Show>
      <Show when={org().plan === "trial" && trialDays() <= 5}>
        <div class="analytics-section">
          <InlineNote tone="warning" icon="warning">
            {trialDays() === 0 ? "The trial ends today." : `${trialDays()} days left in the trial.`} Add a Business
            license to keep distributing the client. <a href={href("/settings")}><strong>Add license</strong></a>.
          </InlineNote>
        </div>
      </Show>

      <div class="ent-grid ent-grid-4 analytics-section">
        <Stat
          label="Active people"
          value={data() ? number(usage()!.activeUsers) : <Skeleton height={26} width="70px" />}
          icon="users"
          delta={data()?.usage ? trend(data()!.spendByDay, "requests") : undefined}
          hint={`${number(data()?.users.active ?? 0)} of ${number(data()?.users.total ?? 0)} accounts`}
        />
        <Stat
          label="Seat usage"
          value={
            <span>
              {number(data()?.seats.used ?? 0)}
              <span class="ent-faint" style={{ "font-size": "15px", "font-weight": "500" }}>
                {" "}
                / {number(data()?.seats.licensed ?? org().license.seats)}
              </span>
            </span>
          }
          icon="shield"
          hint={
            data()?.seats.available === null
              ? "No hard cap on this plan"
              : `${number(data()?.seats.available ?? 0)} seats available`
          }
        />
        <Stat
          label="Spend"
          value={data() ? usd(usage()!.costUsd, usage()!.costUsd < 100 ? 2 : 0) : <Skeleton height={26} width="80px" />}
          icon="models"
          delta={data()?.usage ? trend(data()!.spendByDay, "costUsd") : undefined}
          hint={`Last ${range()} days`}
        />
        <Stat
          label="Tokens"
          value={
            data() ? (
              compact((usage()!.inputTokens ?? 0) + (usage()!.outputTokens ?? 0))
            ) : (
              <Skeleton height={26} width="60px" />
            )
          }
          icon="brain"
          hint={
            data()
              ? `${compact(usage()!.inputTokens)} in · ${compact(usage()!.outputTokens)} out`
              : undefined
          }
        />
      </div>

      <Show when={summary.error}>
        <InlineNote tone="danger" icon="warning">
          {summary.error instanceof Error ? summary.error.message : "Could not load the workspace summary."}
        </InlineNote>
      </Show>

      <Show
        when={data() !== undefined}
        fallback={
          <Card>
            <div class="ent-stack">
              <Skeleton height={180} />
              <Skeleton height={120} />
            </div>
          </Card>
        }
      >
        <div class="ent-split analytics-overview analytics-section">
          <div class="ent-stack">
            <Card
              title="Spend over time"
              description={`Model usage reported by enrolled clients, last ${range()} days.`}
              actions={<Tag tone="muted">{number(usage()!.requests)} requests</Tag>}
            >
              <div class="ent-spread" style={{ "margin-bottom": "10px" }}>
                <div>
                  <div class="ent-label">Total</div>
                  <div style={{ "font-size": "19px", "font-weight": "600", "letter-spacing": "-0.02em" }}>
                    {usd(usage()!.costUsd)}
                  </div>
                </div>
                <div style={{ "text-align": "right" }}>
                  <div class="ent-label">Average / day</div>
                  <div class="ent-mono" style={{ "font-size": "13px" }}>
                    {usd(usage()!.costUsd / range())}
                  </div>
                </div>
              </div>
              <AreaChart data={spendSeries()} height={190} format={(value) => usd(value)} label="Spend by day" />
            </Card>

            <Card
              title="Model mix"
              description="Where the budget goes. Restrict models in Policies."
              actions={
                <Button size="small" variant="ghost" onClick={() => navigate("/policies")}>
                  Manage
                </Button>
              }
            >
              <Show
                when={modelBars().length > 0}
                fallback={
                  <EmptyState
                    compact
                    icon="models"
                    title="No model usage yet"
                    description="Usage appears after an enrolled client completes a turn. Publish a build and ask someone to sign in."
                    action={
                      <Button variant="secondary" size="small" onClick={() => navigate("/distributions")}>
                        Open client builds
                      </Button>
                    }
                  />
                }
              >
                <BarChart data={modelBars()} format={(value) => usd(value)} />
                <div class="ent-row ent-wrap" style={{ "margin-top": "12px", gap: "6px" }}>
                  <For each={data()!.usageByModel}>
                    {(bucket, index) => (
                      <Tag tone="muted">
                        <span
                          class="ent-legend-swatch"
                          style={{ background: PALETTE[index() % PALETTE.length] }}
                        />
                        {bucket.key} · {percent(modelTotal() > 0 ? (bucket.costUsd / modelTotal()) * 100 : 0, 0)}
                      </Tag>
                    )}
                  </For>
                </div>
              </Show>
            </Card>

            <Card
              title="People by spend"
              description="The heaviest usage in this window."
              padded={false}
              actions={
                <Button size="small" variant="ghost" onClick={() => navigate("/usage")}>
                  All usage
                </Button>
              }
            >
              <Show
                when={(data()?.usageByUser.length ?? 0) > 0}
                fallback={
                  <EmptyState compact icon="users" title="No usage attributed yet" description="Spend is attributed to the person whose client reported it." />
                }
              >
                <div class="ent-table-wrap">
                  <table class="ent-table">
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th data-align="right">Requests</th>
                        <th data-align="right">Tokens</th>
                        <th data-align="right">Spend</th>
                        <th data-align="right">Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={data()!.usageByUser}>
                        {(bucket) => (
                          <tr>
                            <td>
                              <span class="ent-truncate" style={{ "font-weight": "500" }}>
                                {bucket.key}
                              </span>
                            </td>
                            <td data-align="right" class="ent-num">
                              {number(bucket.requests)}
                            </td>
                            <td data-align="right" class="ent-num">
                              {compact(bucket.inputTokens + bucket.outputTokens)}
                            </td>
                            <td data-align="right" class="ent-num">
                              {usd(bucket.costUsd)}
                            </td>
                            <td data-align="right" class="ent-num ent-muted">
                              {percent(usage()!.costUsd > 0 ? (bucket.costUsd / usage()!.costUsd) * 100 : 0, 0)}
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </Card>

            <Card
              title="Client builds"
              description={`${data()!.distributions.published} published of ${data()!.distributions.total}`}
              actions={
                <Button size="small" variant="ghost" onClick={() => navigate("/distributions")}>
                  Open
                </Button>
              }
            >
              <Show
                when={data()!.distributions.total > 0}
                fallback={
                  <EmptyState
                    compact
                    icon="download"
                    title="No builds yet"
                    description="Create a branded client with SSO-only sign-in, then publish it to your people."
                    action={
                      <Show when={session.can("distributions:write")}>
                        <Button size="small" variant="primary" icon="plus" onClick={() => navigate("/distributions?new=1")}>
                          New client build
                        </Button>
                      </Show>
                    }
                  />
                }
              >
                <div class="ent-list">
                  <div class="ent-list-row">
                    <span class="ent-auth-point-icon">
                      <Icon name="download" size="small" />
                    </span>
                    <span class="ent-list-row-main">
                      <span class="ent-list-row-title">Published</span>
                      <span class="ent-list-row-sub">
                        {data()!.distributions.published} build{data()!.distributions.published === 1 ? "" : "s"} ready for enrollment
                      </span>
                    </span>
                    <Tag tone="success" dot>
                      live
                    </Tag>
                  </div>
                  <div class="ent-list-row">
                    <span class="ent-auth-point-icon">
                      <Icon name="shield" size="small" />
                    </span>
                    <span class="ent-list-row-main">
                      <span class="ent-list-row-title">Authentication</span>
                      <span class="ent-list-row-sub">SSO only · no personal accounts</span>
                    </span>
                  </div>
                  <div class="ent-list-row">
                    <span class="ent-auth-point-icon">
                      <Icon name="server" size="small" />
                    </span>
                    <span class="ent-list-row-main">
                      <span class="ent-list-row-title">Enrollment</span>
                      <span class="ent-list-row-sub">Served from this server</span>
                    </span>
                    <Tag tone="muted">self-hosted</Tag>
                  </div>
                </div>
              </Show>
            </Card>
          </div>

          <div class="ent-stack">
            <Card
              title="Spend intelligence"
              description={`A straight-line read of the last ${range()} days.`}
              actions={
                <Button size="small" variant="ghost" onClick={() => navigate("/usage")}>
                  Open usage
                </Button>
              }
            >
              <Show
                when={insights()}
                fallback={
                  <div class="ent-grid ent-grid-2" style={{ gap: "10px" }}>
                    <Skeleton height={44} />
                    <Skeleton height={44} />
                    <Skeleton height={44} />
                    <Skeleton height={44} />
                  </div>
                }
              >
                {(value) => (
                  <>
                    <div class="ent-grid ent-grid-2" style={{ gap: "10px" }}>
                      <div>
                        <div class="ent-label">Month to date</div>
                        <div style={{ "font-size": "18px", "font-weight": "600", "letter-spacing": "-0.02em" }}>
                          {usd(value().forecast.monthToDateUsd, value().forecast.monthToDateUsd < 100 ? 2 : 0)}
                        </div>
                      </div>
                      <div>
                        <div class="ent-label">Next 30 days</div>
                        <div style={{ "font-size": "18px", "font-weight": "600", "letter-spacing": "-0.02em" }}>
                          {usd(value().forecast.next30DaysUsd, value().forecast.next30DaysUsd < 100 ? 2 : 0)}
                        </div>
                      </div>
                      <div>
                        <div class="ent-label">Cost / active person</div>
                        <div class="ent-mono" style={{ "font-size": "13px" }}>
                          {usd(value().efficiency.costPerActiveUser)}
                        </div>
                      </div>
                      <div>
                        <div class="ent-label">Top decile share</div>
                        <div class="ent-mono" style={{ "font-size": "13px" }}>
                          {value().concentration.topDecileShare.toFixed(1)}%
                        </div>
                      </div>
                    </div>

                    <Show when={value().departments.length > 0}>
                      <div style={{ margin: "14px 0 8px", "border-top": "1px solid var(--ent-border)" }} />
                      <div class="ent-label" style={{ "margin-bottom": "4px" }}>
                        Department spend
                      </div>
                      <div class="ent-list">
                        <For each={value().departments.slice(0, 3)}>
                          {(department) => (
                            <div class="ent-list-row">
                              <span class="ent-list-row-main">
                                <span class="ent-list-row-title">{department.label}</span>
                                <span class="ent-list-row-sub">{number(department.requests)} requests</span>
                              </span>
                              <span class="ent-list-row-meta">
                                {usd(department.costUsd)} · {department.share.toFixed(1)}%
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>

                    <Show when={value().anomalies.length > 0}>
                      <a
                        class="ent-small"
                        href={href("/usage")}
                        style={{ display: "block", "margin-top": "10px", color: "var(--ent-amber)" }}
                      >
                        {value().anomalies.length} day{value().anomalies.length === 1 ? "" : "s"} at least 2.5×
                        your median day. Review in usage →
                      </a>
                    </Show>

                    <div class="ent-small ent-faint" style={{ "margin-top": "8px" }}>
                      Forecast is a straight-line projection from this window, not a provider invoice.
                    </div>
                  </>
                )}
              </Show>
            </Card>

            <Card
              title="Workspace readiness"
              description={`${readinessDone()} of ${readiness().length} complete`}
              actions={<Tag tone={readinessDone() === readiness().length ? "success" : "warning"}>{readinessDone() === readiness().length ? "Ready" : "Action needed"}</Tag>}
            >
              <Progress value={readinessDone()} max={readiness().length} />
              <div class="ent-list">
                <For each={readiness()}>
                  {(item) => (
                    <a class="ent-list-row" href={href(item.path)}>
                      <span
                        class="ent-auth-point-icon"
                        style={{
                          color: item.done ? "var(--ent-green)" : "var(--ent-faint)",
                          background: item.done ? "var(--ent-green-soft)" : undefined,
                        }}
                      >
                        <Icon name={item.done ? "check" : "arrow-right"} size="small" />
                      </span>
                      <span class="ent-list-row-main">
                        <span class="ent-list-row-title" style={{ "text-decoration": item.done ? "none" : undefined }}>
                          {item.label}
                        </span>
                        <span class="ent-list-row-sub">{item.detail}</span>
                      </span>
                    </a>
                  )}
                </For>
              </div>
            </Card>

            <Card title="Recent activity" description="Security events recorded on this server.">
              <Show
                when={data()!.recentAudit.length > 0}
                fallback={<EmptyState compact icon="review" title="Nothing yet" description="Invitations, sign-ins and policy changes appear here." />}
              >
                <div class="ent-timeline">
                  <For each={data()!.recentAudit}>
                    {(event) => {
                      const label = auditLabel(event.action)
                      return (
                        <div class="ent-timeline-row" data-tone={label.tone}>
                          <span class="ent-timeline-dot" />
                          <div>
                            <div class="ent-timeline-title">{label.title}</div>
                            <div class="ent-timeline-sub">
                              {auditActor(event)}
                              <Show when={event.target}>
                                <span class="ent-dot-sep" />
                                {event.target}
                              </Show>
                            </div>
                          </div>
                          <span class="ent-timeline-time">{relative(event.at)}</span>
                        </div>
                      )
                    }}
                  </For>
                </div>
                <Button variant="ghost" size="small" onClick={() => navigate("/audit")}>
                  Open audit log
                </Button>
              </Show>
            </Card>
          </div>
        </div>

        <div class="ent-grid ent-grid-2 analytics-section">
          <Card title="Tool surface" description="Tool calls reported alongside model usage.">
            <Show
              when={(data()?.topTools.length ?? 0) > 0}
              fallback={<EmptyState compact icon="terminal" title="No tool usage yet" description="Shell, files, browser and computer actions will be listed here." />}
            >
              <BarChart
                data={(data()!.topTools).map((bucket) => ({ key: bucket.key, label: bucket.key, value: bucket.requests }))}
                format={(value) => number(value)}
              />
              <div class="ent-small ent-faint" style={{ "margin-top": "10px" }}>
                {number(toolTotal())} tool calls in the last {range()} days.
              </div>
            </Show>
          </Card>
          <Card title="Requests" description="Model turns by day. Useful for capacity and licensing conversations.">
            <div class="ent-spread" style={{ "margin-bottom": "6px" }}>
              <div>
                <div class="ent-label">Total</div>
                <div style={{ "font-size": "19px", "font-weight": "600" }}>{number(usage()!.requests)}</div>
              </div>
              <div style={{ "text-align": "right" }}>
                <div class="ent-label">Per active person</div>
                <div class="ent-mono" style={{ "font-size": "13px" }}>
                  {number(usage()!.activeUsers > 0 ? usage()!.requests / usage()!.activeUsers : 0)}
                </div>
              </div>
            </div>
            <AreaChart
              data={requestSeries()}
              height={110}
              format={(value) => number(value)}
              label="Requests by day"
              color="var(--ent-green)"
            />
          </Card>
        </div>

        <Show when={usage()!.requests === 0}>
          <div class="analytics-section">
            <Card title="Nothing has reported usage yet" description="The console is live; the numbers fill in as people work.">
              <div class="ent-grid ent-grid-3">
                <div>
                  <div class="ent-label">1 · Publish</div>
                  <p class="ent-muted ent-small" style={{ "margin": "4px 0 8px" }}>
                    Create a client build with your branding and SSO-only sign-in.
                  </p>
                  <Button variant="secondary" size="small" onClick={() => navigate("/distributions")}>
                    Client builds
                  </Button>
                </div>
                <div>
                  <div class="ent-label">2 · Invite</div>
                  <p class="ent-muted ent-small" style={{ "margin": "4px 0 8px" }}>
                    Give people an email or employee-ID account on this server.
                  </p>
                  <Button variant="secondary" size="small" onClick={() => navigate("/users")}>
                    People
                  </Button>
                </div>
                <div>
                  <div class="ent-label">3 · Enroll</div>
                  <p class="ent-muted ent-small" style={{ "margin": "4px 0 8px" }}>
                    Install the build. Usage and audit events arrive as people work.
                  </p>
                  <Button variant="secondary" size="small" onClick={() => navigate("/deployment")}>
                    Deployment
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        </Show>
      </Show>
    </div>
  )
}
