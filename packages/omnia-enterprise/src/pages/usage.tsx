import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { api, download } from "@/lib/api"
import { compact, dateTime, number, percent, shortDate, usd } from "@/lib/format"
import { href, navigate } from "@/lib/router"
import { useSession } from "@/state"
import { AreaChart, BarChart } from "@/components/charts"
import {
  Button,
  Card,
  EmptyState,
  InlineNote,
  PageHeader,
  Select,
  Skeleton,
  Stat,
  Tabs,
  Tag,
} from "@/components/ui"
import type { UsageBucket, UsageResponse } from "@/types"
import "./analytics.css"

const RANGES = [7, 30, 90] as const
const GROUPS = [
  { id: "day", label: "Day" },
  { id: "user", label: "Person" },
  { id: "model", label: "Model" },
  { id: "tool", label: "Tool" },
] as const

type Group = (typeof GROUPS)[number]["id"]

function bucketKeyLabel(key: string, group: Group): string {
  if (group !== "day") return key
  const parsed = new Date(`${key}T12:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? key : shortDate(parsed.getTime())
}

function bucketTotal(bucket: UsageBucket): number {
  return bucket.inputTokens + bucket.outputTokens
}

export function UsagePage() {
  const session = useSession()
  const [days, setDays] = createSignal<(typeof RANGES)[number]>(30)
  const [group, setGroup] = createSignal<Group>("day")
  const [person, setPerson] = createSignal("")
  const [model, setModel] = createSignal("")

  const [usage, { refetch }] = createResource(
    () => ({ days: days(), groupBy: group(), userId: person(), model: model() }),
    (params) => api.usage(params),
  )
  const [summary] = createResource(days, (value) => api.summary(value))
  const [insights] = createResource(days, (value) => api.usageInsights(value).catch(() => undefined))

  const activePeople = () => summary()?.summary.usage.activeUsers ?? 0
  const total = (data: UsageResponse) => data.total
  const averageCost = (data: UsageResponse) =>
    data.total.requests > 0 ? data.total.costUsd / data.total.requests : 0
  const costPerPerson = (data: UsageResponse) => (activePeople() > 0 ? data.total.costUsd / activePeople() : 0)
  const tokensPerRequest = (data: UsageResponse) =>
    data.total.requests > 0 ? (data.total.inputTokens + data.total.outputTokens) / data.total.requests : 0

  const buckets = createMemo<UsageBucket[]>(() => {
    const list = usage()?.buckets ?? []
    if (group() === "tool") return [...list].sort((a, b) => b.requests - a.requests)
    return [...list].sort((a, b) => b.costUsd - a.costUsd)
  })

  const chart = createMemo(() => {
    if (group() === "day") {
      return [...(usage()?.buckets ?? [])].reverse().map((bucket) => {
        const parsed = new Date(`${bucket.key}T12:00:00Z`)
        return {
          key: bucket.key,
          label: Number.isNaN(parsed.getTime()) ? bucket.key : shortDate(parsed.getTime()),
          value: bucket.costUsd,
        }
      })
    }
    return buckets().map((bucket) => ({
      key: bucket.key,
      label: bucketKeyLabel(bucket.key, group()),
      value: group() === "tool" ? bucket.requests : bucket.costUsd,
    }))
  })

  const chartTitle = () =>
    group() === "day"
      ? "Spend by day"
      : group() === "user"
        ? "Spend by person"
        : group() === "model"
          ? "Spend by model"
          : "Calls by tool"

  const chartFormat = () => (group() === "tool" ? (value: number) => number(value) : (value: number) => usd(value))

  const policies = () => session.session()!.organization.policies

  const people = () => usage()?.users ?? []
  const models = () => usage()?.models ?? []

  const personOptions = createMemo(() => [
    { value: "", label: "All people" },
    ...people().map((entry) => ({ value: entry.id, label: entry.email || entry.name })),
  ])

  const modelOptions = createMemo(() => [
    { value: "", label: "All models" },
    ...models().map((entry) => ({ value: entry, label: entry })),
  ])

  const personLabel = (id: string) => {
    const found = people().find((entry) => entry.id === id)
    return found === undefined ? id : found.email || found.name
  }

  return (
    <div class="ent-page">
      <PageHeader
        kicker="Governance"
        title="Usage & spend"
        description="Your own record of model turns, reported by enrolled clients. These numbers never leave this server and are not a provider invoice."
        actions={
          <>
            <div class="ent-tabs analytics-range">
              <For each={RANGES}>
                {(value) => (
                  <button
                    type="button"
                    class="ent-button"
                    data-size="small"
                    data-variant={days() === value ? "secondary" : "ghost"}
                    onClick={() => setDays(value)}
                  >
                    {value}d
                  </button>
                )}
              </For>
            </div>
            <Show when={session.can("audit:export")}>
              <Button variant="secondary" icon="download" onClick={() => download("/usage/export")}>
                Export CSV
              </Button>
            </Show>
          </>
        }
      />

      <div class="ent-toolbar analytics-filters">
        <span class="ent-label">Filters</span>
        <div class="analytics-filter analytics-filter-person">
          <Select value={person()} onChange={(value) => setPerson(value)} options={personOptions()} />
        </div>
        <div class="analytics-filter analytics-filter-model">
          <Select value={model()} onChange={(value) => setModel(value)} options={modelOptions()} />
        </div>
        <Show when={person().length > 0 || model().length > 0}>
          <Button
            size="small"
            variant="ghost"
            icon="close"
            onClick={() => {
              setPerson("")
              setModel("")
            }}
          >
            Clear
          </Button>
        </Show>
        <span class="ent-topbar-spacer" />
        <Button size="small" variant="ghost" icon="reset" onClick={() => void refetch()}>
          Refresh
        </Button>
      </div>

      <Show when={usage.error}>
        <div style={{ "margin-bottom": "14px" }}>
          <InlineNote tone="danger" icon="warning">
            <div class="ent-spread">
              <span>{usage.error instanceof Error ? usage.error.message : "Usage could not be loaded."}</span>
              <Button size="small" variant="secondary" onClick={() => void refetch()}>
                Retry
              </Button>
            </div>
          </InlineNote>
        </div>
      </Show>

      <Show
        when={usage()}
        fallback={
          <Show
            when={usage.error}
            fallback={
              <div class="ent-stack">
                <div class="ent-grid ent-grid-4">
                  <For each={[1, 2, 3, 4]}>
                    {() => (
                      <div class="ent-stat">
                        <Skeleton height={12} width="45%" />
                        <div style={{ "margin-top": "10px" }}>
                          <Skeleton height={26} width="70%" />
                        </div>
                        <div style={{ "margin-top": "8px" }}>
                          <Skeleton height={10} width="55%" />
                        </div>
                      </div>
                    )}
                  </For>
                </div>
                <Card>
                  <Skeleton height={220} />
                </Card>
              </div>
            }
          >
            <EmptyState
              icon="warning"
              title="Usage could not be loaded"
              description={usage.error instanceof Error ? usage.error.message : "The server rejected the request."}
              action={
                <Button variant="secondary" onClick={() => void refetch()}>
                  Try again
                </Button>
              }
            />
          </Show>
        }
      >
        {(data) => (
          <>
            <div class="ent-grid ent-grid-4 analytics-section">
              <Stat
                label="Spend"
                value={usd(total(data()).costUsd, total(data()).costUsd < 100 ? 2 : 0)}
                icon="models"
                hint={`Last ${days()} days`}
              />
              <Stat
                label="Requests"
                value={number(total(data()).requests)}
                icon="status"
                hint="Model turns reported by clients"
              />
              <Stat
                label="Input tokens"
                value={compact(total(data()).inputTokens)}
                icon="brain"
                hint={`${percent(total(data()).inputTokens + total(data()).outputTokens > 0 ? (total(data()).inputTokens / (total(data()).inputTokens + total(data()).outputTokens)) * 100 : 0, 0)} of tokens`}
              />
              <Stat
                label="Output tokens"
                value={compact(total(data()).outputTokens)}
                icon="terminal"
                hint={`${compact(total(data()).inputTokens + total(data()).outputTokens)} total`}
              />
              <Stat
                label="Active people"
                value={number(activePeople())}
                icon="users"
                hint={
                  summary() === undefined
                    ? "Accounts that reported usage"
                    : `${number(summary()!.summary.users.active)} active accounts`
                }
              />
              <Stat
                label="Avg cost / request"
                value={usd(averageCost(data()), 3)}
                icon="dash"
                hint="Spend divided by reported turns"
              />
              <Stat
                label="Cost / active person"
                value={usd(costPerPerson(data()))}
                icon="shield"
                hint="Whole workspace · useful for seat reviews"
              />
              <Stat
                label="Tokens / request"
                value={compact(tokensPerRequest(data()))}
                icon="models"
                hint="Average context carried by each turn"
              />
            </div>

            <Show when={total(data()).requests === 0}>
              <div class="analytics-empty">
                <EmptyState
                  compact
                  icon="models"
                  title="No usage in this window"
                  description="Enrolled clients report one event per model turn. Publish a client build, ask someone to sign in, and the numbers appear here as they work."
                  action={
                    <Button variant="primary" icon="arrow-right" onClick={() => navigate("/distributions")}>
                      Open client builds
                    </Button>
                  }
                />
              </div>
            </Show>

            <Show when={total(data()).requests > 0}>
              <Show when={insights()}>
                {(intel) => (
                  <div class="analytics-section">
                    <div class="ent-grid ent-grid-4 analytics-section">
                      <Stat
                        label="Month to date"
                        value={usd(intel().forecast.monthToDateUsd, 2)}
                        icon="models"
                        hint={`${usd(intel().forecast.next30DaysUsd)} projected for 30 days`}
                      />
                      <Stat
                        label="Cost / active person"
                        value={usd(intel().efficiency.costPerActiveUser)}
                        icon="shield"
                        hint={`${number(intel().efficiency.requestsPerActiveUser)} requests per person`}
                      />
                      <Stat
                        label="Tokens / request"
                        value={compact(intel().efficiency.tokensPerRequest)}
                        icon="brain"
                        hint={
                          intel().efficiency.averageDurationMs > 0
                            ? `${intel().efficiency.inputShare.toFixed(0)}% input · ${usd(intel().efficiency.costPer1kTokens, 3)} / 1k tokens · ${(intel().efficiency.averageDurationMs / 1_000).toFixed(1)}s average turn`
                            : `${intel().efficiency.inputShare.toFixed(0)}% input · ${usd(intel().efficiency.costPer1kTokens, 3)} / 1k tokens`
                        }
                      />
                      <Stat
                        label="Top decile share"
                        value={`${intel().concentration.topDecileShare.toFixed(0)}%`}
                        icon="subagent"
                        hint={`Top five people · ${intel().concentration.topFiveShare.toFixed(0)}% of spend`}
                      />
                    </div>

                    <div class="ent-split">
                      <Card
                        title="Department spend"
                        description="Cost follows the department on each person's profile. Unassigned people are grouped together."
                        padded={false}
                      >
                        <Show
                          when={intel().departments.length > 0}
                          fallback={
                            <EmptyState
                              compact
                              icon="subagent"
                              title="No department data"
                              description="Add a department to people profiles to see spend by team."
                              action={
                                <Button size="small" variant="secondary" onClick={() => navigate("/users")}>
                                  Open people
                                </Button>
                              }
                            />
                          }
                        >
                          <div class="ent-table-wrap">
                            <table class="ent-table">
                              <thead>
                                <tr>
                                  <th>Department</th>
                                  <th data-align="right">Requests</th>
                                  <th data-align="right">Tokens</th>
                                  <th data-align="right">Spend</th>
                                  <th data-align="right">Share</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For each={intel().departments}>
                                  {(row) => (
                                    <tr>
                                      <td>
                                        <span class="ent-truncate" style={{ "font-weight": "500" }}>
                                          {row.label}
                                        </span>
                                      </td>
                                      <td data-align="right" class="ent-num">
                                        {number(row.requests)}
                                      </td>
                                      <td data-align="right" class="ent-num">
                                        {compact(bucketTotal(row))}
                                      </td>
                                      <td data-align="right" class="ent-num">
                                        {usd(row.costUsd, row.costUsd < 100 ? 2 : 0)}
                                      </td>
                                      <td data-align="right" class="ent-num ent-muted">
                                        {row.share.toFixed(1)}%
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
                        title="Model efficiency"
                        description="Cost and context per turn, so expensive models are easy to spot."
                        padded={false}
                      >
                        <Show
                          when={intel().models.length > 0}
                          fallback={<EmptyState compact icon="models" title="No models" description="No model usage in this window." />}
                        >
                          <div class="ent-table-wrap">
                            <table class="ent-table">
                              <thead>
                                <tr>
                                  <th>Model</th>
                                  <th data-align="right">Requests</th>
                                  <th data-align="right">Avg / request</th>
                                  <th data-align="right">Tokens / request</th>
                                  <th data-align="right">Share</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For each={intel().models}>
                                  {(row) => (
                                    <tr>
                                      <td>
                                        <span class="ent-mono ent-truncate" title={row.label}>
                                          {row.label}
                                        </span>
                                      </td>
                                      <td data-align="right" class="ent-num">
                                        {number(row.requests)}
                                      </td>
                                      <td data-align="right" class="ent-num">
                                        {usd(row.averageCostUsd, 3)}
                                      </td>
                                      <td data-align="right" class="ent-num ent-muted">
                                        {compact(row.tokensPerRequest)}
                                      </td>
                                      <td data-align="right" class="ent-num ent-muted">
                                        {row.share.toFixed(1)}%
                                      </td>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                          </div>
                        </Show>
                      </Card>
                    </div>

                    <Show when={intel().anomalies.length > 0}>
                      <div class="analytics-section" style={{ "margin-top": "14px" }}>
                        <Card
                          title="Days outside the baseline"
                          description="Each day is compared with this tenant's own median day, not an industry benchmark."
                          actions={<Tag tone="warning">{intel().anomalies.length} flagged</Tag>}
                        >
                          <div class="ent-list">
                            <For each={intel().anomalies}>
                              {(anomaly) => (
                                <div class="ent-list-row">
                                  <span class="ent-auth-point-icon">
                                    <Icon name="warning" size="small" />
                                  </span>
                                  <span class="ent-list-row-main">
                                    <span class="ent-list-row-title">
                                      {shortDate(new Date(`${anomaly.day}T12:00:00Z`).getTime())}
                                    </span>
                                    <span class="ent-list-row-sub">
                                      {usd(anomaly.costUsd)} reported · {anomaly.multiple.toFixed(1)}× the median day
                                    </span>
                                  </span>
                                  <Tag tone="warning">review</Tag>
                                </div>
                              )}
                            </For>
                          </div>
                        </Card>
                      </div>
                    </Show>
                  </div>
                )}
              </Show>

              <div class="ent-split analytics-usage-body">
                <div class="ent-stack">
                  <Card
                    title={chartTitle()}
                    description={
                      group() === "day"
                        ? `Spend and volume for the last ${days()} days.`
                        : "The same window, grouped the way you need to read it."
                    }
                    actions={
                      <Tabs
                        tabs={GROUPS.map((entry) => ({ id: entry.id, label: entry.label }))}
                        active={group()}
                        onChange={(id) => setGroup(id)}
                      />
                    }
                  >
                    <div class="ent-spread" style={{ "margin-bottom": "12px" }}>
                      <div>
                        <div class="ent-label">
                          {group() === "tool" ? "Tool calls" : "Total spend"}
                        </div>
                        <div style={{ "font-size": "20px", "font-weight": "600", "letter-spacing": "-0.025em" }}>
                          {group() === "tool"
                            ? number(total(data()).requests)
                            : usd(total(data()).costUsd)}
                        </div>
                      </div>
                      <div style={{ "text-align": "right" }}>
                        <div class="ent-label">Average / day</div>
                        <div class="ent-mono" style={{ "font-size": "13px" }}>
                          {group() === "tool"
                            ? number(total(data()).requests / days())
                            : usd(total(data()).costUsd / days())}
                        </div>
                      </div>
                    </div>
                    <Show
                      when={chart().length > 0}
                      fallback={
                        <EmptyState
                          compact
                          icon="status"
                          title="Nothing to chart"
                          description="Try a wider date range or clear the filters."
                        />
                      }
                    >
                      <Show
                        when={group() === "day"}
                        fallback={
                          <BarChart
                            data={chart()}
                            format={chartFormat()}
                            color={group() === "tool" ? "var(--ent-green)" : undefined}
                          />
                        }
                      >
                        <AreaChart
                          data={chart()}
                          height={220}
                          format={(value) => usd(value)}
                          label="Spend over time"
                        />
                      </Show>
                    </Show>
                  </Card>

                  <Card
                    title="Breakdown"
                    description={`Grouped by ${GROUPS.find((entry) => entry.id === group())?.label.toLowerCase()}.`}
                    padded={false}
                  >
                    <div class="ent-table-wrap">
                      <table class="ent-table">
                        <thead>
                          <tr>
                            <th>{group() === "day" ? "Date" : group() === "user" ? "Person" : group() === "model" ? "Model" : "Tool"}</th>
                            <th data-align="right">Requests</th>
                            <th data-align="right">Tokens</th>
                            <th data-align="right">Spend</th>
                            <th data-align="right">Share</th>
                            <th data-align="right">Avg / request</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={buckets()}>
                            {(bucket) => (
                              <tr>
                                <td>
                                  <span class="ent-truncate" style={{ "font-weight": "500" }}>
                                    {bucketKeyLabel(bucket.key, group())}
                                  </span>
                                </td>
                                <td data-align="right" class="ent-num">
                                  {number(bucket.requests)}
                                </td>
                                <td data-align="right" class="ent-num">
                                  {compact(bucketTotal(bucket))}
                                </td>
                                <td data-align="right" class="ent-num">
                                  {usd(bucket.costUsd)}
                                </td>
                                <td data-align="right" class="ent-num ent-muted">
                                  {percent(total(data()).costUsd > 0 ? (bucket.costUsd / total(data()).costUsd) * 100 : 0, 1)}
                                </td>
                                <td data-align="right" class="ent-num ent-muted">
                                  {usd(bucket.requests > 0 ? bucket.costUsd / bucket.requests : 0, 3)}
                                </td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                    <Show when={buckets().length === 0}>
                      <EmptyState compact icon="dash" title="No rows" description="No usage matches the current filters." />
                    </Show>
                  </Card>

                  <Card
                    title="Recent events"
                    description={`The newest ${data().events.length} reported turns in this window.`}
                    padded={false}
                  >
                    <Show
                      when={data().events.length > 0}
                      fallback={
                        <EmptyState
                          compact
                          icon="review"
                          title="No events"
                          description="Events are appended when an enrolled client finishes a turn."
                        />
                      }
                    >
                      <div class="ent-table-wrap">
                        <table class="ent-table">
                          <thead>
                            <tr>
                              <th>Time</th>
                              <th>Person</th>
                              <th>Model</th>
                              <th data-align="right">Tokens</th>
                              <th data-align="right">Cost</th>
                              <th>Tool</th>
                              <th>Session</th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={data().events}>
                              {(event) => (
                                <tr>
                                  <td class="ent-small ent-muted">{dateTime(event.at)}</td>
                                  <td>
                                    <span class="ent-truncate">{personLabel(event.userId)}</span>
                                  </td>
                                  <td>
                                    <span class="ent-mono" title={event.provider ?? undefined}>
                                      {event.model}
                                    </span>
                                  </td>
                                  <td data-align="right" class="ent-num">
                                    {compact(event.inputTokens + event.outputTokens)}
                                  </td>
                                  <td data-align="right" class="ent-num">
                                    {usd(event.costUsd, 3)}
                                  </td>
                                  <td>
                                    <Show when={event.tool} fallback={<span class="ent-faint">—</span>}>
                                      {(tool) => <Tag tone="muted">{tool()}</Tag>}
                                    </Show>
                                  </td>
                                  <td>
                                    <Show when={event.sessionId} fallback={<span class="ent-faint">—</span>}>
                                      {(id) => (
                                        <span class="ent-mono ent-faint" title={id()}>
                                          {id().slice(0, 12)}…
                                        </span>
                                      )}
                                    </Show>
                                  </td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    </Show>
                  </Card>
                </div>

                <div class="ent-stack analytics-usage-rail">
                  <Card
                    title="Budget guardrails"
                    description="Workspace-wide controls. A client build can narrow them further."
                    actions={
                      <Button size="small" variant="ghost" onClick={() => navigate("/policies")}>
                        Edit
                      </Button>
                    }
                  >
                    <div class="ent-list">
                      <div class="ent-list-row">
                        <span class="ent-list-row-main">
                          <span class="ent-list-row-title">Session length</span>
                          <span class="ent-list-row-sub">How long a console session lasts</span>
                        </span>
                        <span class="ent-list-row-meta">{policies().sessionHours} hr</span>
                      </div>
                      <div class="ent-list-row">
                        <span class="ent-list-row-main">
                          <span class="ent-list-row-title">Idle timeout</span>
                          <span class="ent-list-row-sub">Inactive sessions are ended</span>
                        </span>
                        <span class="ent-list-row-meta">{policies().idleTimeoutMinutes} min</span>
                      </div>
                      <div class="ent-list-row">
                        <span class="ent-list-row-main">
                          <span class="ent-list-row-title">Model access</span>
                          <span class="ent-list-row-sub">
                            {policies().model.mode === "allowlist"
                              ? "Only listed models are allowed"
                              : "Listed models are blocked"}
                          </span>
                        </span>
                        <Tag tone="muted">{number(policies().model.models.length)} listed</Tag>
                      </div>
                      <div class="ent-list-row">
                        <span class="ent-list-row-main">
                          <span class="ent-list-row-title">Usage retention</span>
                          <span class="ent-list-row-sub">Retention window for data on this server</span>
                        </span>
                        <span class="ent-list-row-meta">{policies().data.retentionDays} days</span>
                      </div>
                      <div class="ent-list-row">
                        <span class="ent-list-row-main">
                          <span class="ent-list-row-title">MFA and network</span>
                          <span class="ent-list-row-sub">Sign-in hardening</span>
                        </span>
                        <div class="ent-row">
                          <Tag tone={policies().requireMfa ? "success" : "muted"}>
                            {policies().requireMfa ? "MFA" : "No MFA"}
                          </Tag>
                          <Tag tone={policies().ipAllowlist.length > 0 ? "success" : "muted"}>
                            {policies().ipAllowlist.length > 0 ? `${policies().ipAllowlist.length} IP rules` : "Any IP"}
                          </Tag>
                        </div>
                      </div>
                    </div>
                  </Card>

                  <Card title="Report scope" description="What this view includes.">
                    <div class="ent-list">
                      <div class="ent-list-row">
                        <span class="ent-list-row-main">
                          <span class="ent-list-row-title">Source</span>
                          <span class="ent-list-row-sub">Usage events reported by enrolled clients</span>
                        </span>
                        <Tag tone="accent">own record</Tag>
                      </div>
                      <div class="ent-list-row">
                        <span class="ent-list-row-main">
                          <span class="ent-list-row-title">Window</span>
                          <span class="ent-list-row-sub">Oldest event to now</span>
                        </span>
                        <span class="ent-list-row-meta">{days()} days</span>
                      </div>
                      <div class="ent-list-row">
                        <span class="ent-list-row-main">
                          <span class="ent-list-row-title">Export</span>
                          <span class="ent-list-row-sub">Every stored event, not just this page</span>
                        </span>
                        <Show
                          when={session.can("audit:export")}
                          fallback={<Tag tone="muted">auditor only</Tag>}
                        >
                          <Button size="small" variant="ghost" icon="download" onClick={() => download("/usage/export")}>
                            CSV
                          </Button>
                        </Show>
                      </div>
                    </div>
                    <div style={{ "margin-top": "10px" }}>
                      <InlineNote icon="help">
                        Spend is reported by clients and priced at the model rate in effect there. Costs are an
                        operational signal, not a substitute for a provider invoice.
                      </InlineNote>
                    </div>
                  </Card>

                  <Card title="Try another view">
                    <div class="ent-list">
                      <a class="ent-list-row" href={href("/policies")}>
                        <span class="ent-list-row-main">
                          <span class="ent-list-row-title">Restrict expensive models</span>
                          <span class="ent-list-row-sub">Policy changes apply to new turns</span>
                        </span>
                        <span class="ent-list-row-meta">→</span>
                      </a>
                      <a class="ent-list-row" href={href("/audit")}>
                        <span class="ent-list-row-main">
                          <span class="ent-list-row-title">Audit sign-ins and exports</span>
                          <span class="ent-list-row-sub">Who did what, with timestamps</span>
                        </span>
                        <span class="ent-list-row-meta">→</span>
                      </a>
                      <a class="ent-list-row" href={href("/distributions")}>
                        <span class="ent-list-row-main">
                          <span class="ent-list-row-title">Tune client limits</span>
                          <span class="ent-list-row-sub">Per-build token and spend ceilings</span>
                        </span>
                        <span class="ent-list-row-meta">→</span>
                      </a>
                    </div>
                  </Card>
                </div>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
