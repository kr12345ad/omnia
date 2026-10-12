import { For, Show, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"

// Flight-recorder view of the computer-use trail.
//
// Reads GET /v1/audit/computer-use (packages/omnia/src/server/api.ts) and renders
// every computer-use action the server journaled: which observation the target
// came from, the aim point and the strategy that chose it, who permitted the
// action, and whether a post-action read confirmed it. A `bounds-center` aim is
// highlighted because it is a recorded guess, not a resolved control.
//
// The endpoint is authenticated, so the host supplies where the Omnia server
// lives and which bearer carries the operator. The renderer never persists
// either value: it is passed in, held for the lifetime of this view, and sent
// only to that server. When no source is configured, or the request fails, or
// the answer is not the documented shape, the view degrades to a message
// instead of inventing records.
//
// Protocol vocabulary (action names, aim strategies, verified / not_verified) is
// rendered verbatim: it is data, not prose. Everything a reader has to understand
// comes from the dictionary.

export interface ComputerUseAuditSource {
  /** Omnia server origin, for example `http://127.0.0.1:4096`. Empty means same origin. */
  readonly baseUrl?: string
  /** Operator bearer. The endpoint refuses any caller that is not the desktop operator. */
  readonly token?: string
}

export interface ComputerUseAuditAim {
  readonly x: number
  readonly y: number
  readonly strategy: string
}

export interface ComputerUseAuditPermission {
  readonly allowed: boolean
  readonly status: "allowed" | "prompt" | "denied"
  readonly by?: string
  readonly at: number
  readonly scopes?: readonly string[]
}

export interface ComputerUseAuditResult {
  readonly status: "verified" | "not_verified"
  readonly expected?: unknown
  readonly observed?: unknown
  readonly method?: string
  readonly reason?: string
}

export interface ComputerUseAuditRecord {
  readonly type: "computer_use.action"
  readonly at: number
  readonly serverId: string
  readonly computerId: string
  readonly action: string
  readonly observationId?: string
  readonly generation?: number
  readonly ref?: string
  readonly query?: string
  readonly target?: string
  readonly aim?: ComputerUseAuditAim
  readonly permission: ComputerUseAuditPermission
  readonly result: ComputerUseAuditResult
  readonly sessionId?: string
}

export interface ComputerUseAuditTrail {
  readonly records: readonly ComputerUseAuditRecord[]
  readonly chain: "ok" | "broken" | "unavailable"
  readonly verifiedThrough: number
  readonly total: number
  readonly error?: string
}

export interface ComputerUseAuditTrailProps {
  readonly source?: ComputerUseAuditSource
}

const AUDIT_LIMIT = 200
const AUDIT_TIMEOUT_MS = 8000

type Copy = (key: string, params?: Record<string, string | number | boolean>) => string

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function aimOf(source: Record<string, unknown>): ComputerUseAuditAim | undefined {
  const aim = source.aim
  if (!isRecord(aim) || typeof aim.x !== "number" || typeof aim.y !== "number") return undefined
  return { x: aim.x, y: aim.y, strategy: stringField(aim, "strategy") ?? "unknown" }
}

function permissionOf(source: Record<string, unknown>): ComputerUseAuditPermission | undefined {
  const permission = source.permission
  if (!isRecord(permission)) return undefined
  const status = permission.status
  if (status !== "allowed" && status !== "prompt" && status !== "denied") return undefined
  const scopes = Array.isArray(permission.scopes) ? permission.scopes.flatMap((scope) => (typeof scope === "string" ? [scope] : [])) : []
  return {
    allowed: permission.allowed === true,
    status,
    ...(stringField(permission, "by") === undefined ? {} : { by: stringField(permission, "by")! }),
    at: typeof permission.at === "number" ? permission.at : 0,
    ...(scopes.length === 0 ? {} : { scopes }),
  }
}

function resultOf(source: Record<string, unknown>): ComputerUseAuditResult | undefined {
  const result = source.result
  if (!isRecord(result)) return undefined
  const status = result.status
  if (status !== "verified" && status !== "not_verified") return undefined
  return {
    status,
    ...(result.expected === undefined ? {} : { expected: result.expected }),
    ...(result.observed === undefined ? {} : { observed: result.observed }),
    ...(stringField(result, "method") === undefined ? {} : { method: stringField(result, "method")! }),
    ...(stringField(result, "reason") === undefined ? {} : { reason: stringField(result, "reason")! }),
  }
}

function recordOf(entry: unknown): ComputerUseAuditRecord | undefined {
  if (!isRecord(entry)) return undefined
  if (entry.type !== "computer_use.action" || typeof entry.action !== "string") return undefined
  if (typeof entry.computerId !== "string" || typeof entry.at !== "number") return undefined
  if (typeof entry.serverId !== "string") return undefined
  const permission = permissionOf(entry)
  const result = resultOf(entry)
  if (permission === undefined || result === undefined) return undefined
  const aim = aimOf(entry)
  const observationId = stringField(entry, "observationId")
  const ref = stringField(entry, "ref")
  const query = stringField(entry, "query")
  const target = stringField(entry, "target")
  const sessionId = stringField(entry, "sessionId")
  return {
    type: "computer_use.action",
    at: entry.at,
    serverId: entry.serverId,
    computerId: entry.computerId,
    action: entry.action,
    ...(typeof entry.generation === "number" ? { generation: entry.generation } : {}),
    ...(observationId === undefined ? {} : { observationId }),
    ...(ref === undefined ? {} : { ref }),
    ...(query === undefined ? {} : { query }),
    ...(target === undefined ? {} : { target }),
    ...(aim === undefined ? {} : { aim }),
    permission,
    result,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

function parseTrail(value: unknown): ComputerUseAuditTrail | undefined {
  if (!isRecord(value) || !Array.isArray(value.records)) return undefined
  const chain = value.chain
  if (chain !== "ok" && chain !== "broken" && chain !== "unavailable") return undefined
  if (typeof value.verifiedThrough !== "number" || typeof value.total !== "number") return undefined
  const records = value.records.flatMap((entry) => {
    const record = recordOf(entry)
    return record === undefined ? [] : [record]
  })
  return {
    records,
    chain,
    verifiedThrough: value.verifiedThrough,
    total: value.total,
    ...(stringField(value, "error") === undefined ? {} : { error: stringField(value, "error")! }),
  }
}

function auditUrl(source: ComputerUseAuditSource | undefined, filter: { computerId: string; since?: number }): string {
  const params = new URLSearchParams()
  if (filter.computerId.length > 0) params.set("computerId", filter.computerId)
  if (filter.since !== undefined) params.set("since", String(filter.since))
  params.set("limit", String(AUDIT_LIMIT))
  const query = params.toString()
  const base = source?.baseUrl ?? ""
  return `${base.replace(/\/+$/, "")}/v1/audit/computer-use?${query}`
}

function timeLabel(at: number): string {
  const date = new Date(at)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(at)
}

function jsonLine(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

function aimLine(copy: Copy, entry: ComputerUseAuditRecord): string | undefined {
  if (entry.aim === undefined) return undefined
  return copy("settings.computerUse.audit.line.aim", {
    x: entry.aim.x,
    y: entry.aim.y,
    strategy: entry.aim.strategy,
  })
}

function targetLine(copy: Copy, entry: ComputerUseAuditRecord): string {
  const parts = [copy("settings.computerUse.audit.line.permission", { status: entry.permission.status })]
  if (entry.permission.by !== undefined) parts.push(entry.permission.by)
  if (entry.permission.scopes !== undefined && entry.permission.scopes.length > 0) {
    parts.push(entry.permission.scopes.join(", "))
  }
  if (entry.ref !== undefined) parts.push(copy("settings.computerUse.audit.line.ref", { ref: entry.ref }))
  if (entry.query !== undefined) parts.push(copy("settings.computerUse.audit.line.query", { query: entry.query }))
  if (entry.observationId !== undefined) {
    parts.push(
      entry.generation === undefined
        ? copy("settings.computerUse.audit.line.observation", { observationId: entry.observationId })
        : copy("settings.computerUse.audit.line.observationGeneration", {
            observationId: entry.observationId,
            generation: entry.generation,
          }),
    )
  }
  return parts.join(" · ")
}

function evidenceLine(copy: Copy, entry: ComputerUseAuditRecord): string | undefined {
  const expected =
    entry.result.expected === undefined
      ? undefined
      : copy("settings.computerUse.audit.line.expected", { value: jsonLine(entry.result.expected) })
  const observed =
    entry.result.observed === undefined
      ? undefined
      : copy("settings.computerUse.audit.line.observed", { value: jsonLine(entry.result.observed) })
  if (expected === undefined) return observed
  if (observed === undefined) return expected
  return `${expected} ${observed}`
}

export function ComputerUseAuditTrail(props: ComputerUseAuditTrailProps) {
  const language = useLanguage()
  const copy: Copy = (key, params) => language.t(key as Parameters<typeof language.t>[0], params)
  const [store, setStore] = createStore({
    computerId: "",
    verifiedOnly: false,
    since: "",
    records: [] as readonly ComputerUseAuditRecord[],
    chain: "ok" as ComputerUseAuditTrail["chain"],
    verifiedThrough: 0,
    total: 0,
    loading: true,
    error: "",
  })

  const load = async (next?: { readonly computerId?: string; readonly since?: string }) => {
    const computerId = (next?.computerId ?? store.computerId).trim()
    const sinceValue = next?.since ?? store.since
    const since =
      sinceValue.length === 0 ? undefined : new Date(`${sinceValue}T00:00:00`).getTime()
    setStore({ loading: true, error: "" })
    const source = props.source
    try {
      const headers: Record<string, string> = { accept: "application/json" }
      if (source?.token !== undefined && source.token.length > 0) headers.authorization = `Bearer ${source.token}`
      const response = await fetch(auditUrl(source, {
        computerId,
        ...(since === undefined || !Number.isFinite(since) ? {} : { since: Math.floor(since) }),
      }), {
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(AUDIT_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body: unknown = await response.json()
      const trail = parseTrail(isRecord(body) ? body.trail : undefined)
      if (trail === undefined) throw new Error("unexpected response shape")
      setStore({
        records: trail.records,
        chain: trail.chain,
        verifiedThrough: trail.verifiedThrough,
        total: trail.total,
        loading: false,
      })
    } catch (error) {
      // An unreachable, unauthorized or unreadable trail is reported as such.
      // The view never falls back to records it did not read.
      setStore({
        records: [],
        chain: "unavailable",
        verifiedThrough: 0,
        total: 0,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  onMount(() => void load())

  const visible = createMemo(() =>
    store.verifiedOnly ? store.records.filter((entry) => entry.result.status === "verified") : store.records,
  )

  return (
    <section class="settings-v2-section" aria-labelledby="computer-use-audit-title">
      <div class="flex flex-col gap-1">
        <h3 id="computer-use-audit-title" class="settings-v2-section-title">
          {language.t("settings.computerUse.title")}
        </h3>
        <p class="text-[13px] font-[440] text-v2-text-text-muted">
          {language.t("settings.computerUse.audit.description")}
        </p>
      </div>
      <div class="mt-3 flex flex-wrap items-end gap-3">
        <TextField
          class="w-48"
          label={language.t("settings.computerUse.audit.computer")}
          placeholder={language.t("settings.computerUse.audit.computerPlaceholder")}
          value={store.computerId}
          onChange={(value) => {
            setStore("computerId", value)
            void load({ computerId: value })
          }}
        />
        <TextField
          class="w-40"
          label={language.t("settings.computerUse.audit.since")}
          type="date"
          value={store.since}
          onChange={(value) => {
            setStore("since", value)
            void load({ since: value })
          }}
        />
        <Checkbox checked={store.verifiedOnly} onChange={(checked) => setStore("verifiedOnly", checked)}>
          {language.t("settings.computerUse.audit.verifiedOnly")}
        </Checkbox>
        <Button variant="secondary" size="small" disabled={store.loading} onClick={() => void load()}>
          {store.loading ? language.t("common.loading") : language.t("settings.computerUse.audit.refresh")}
        </Button>
      </div>
      <Show when={store.loading}>
        <p class="mt-3 text-[13px] font-[440] text-v2-text-text-muted">{language.t("common.loading")}</p>
      </Show>
      <Show when={!store.loading && store.error}>
        <p role="alert" class="mt-3 text-[12px] font-[440] text-v2-state-fg-danger">
          {language.t("settings.computerUse.audit.unavailable")} {store.error}
        </p>
      </Show>
      <Show when={!store.loading && !store.error && store.chain === "broken"}>
        <p role="alert" class="mt-3 text-[12px] font-[440] text-v2-state-fg-danger">
          {language.t("settings.computerUse.audit.chainBroken")}
        </p>
      </Show>
      <Show when={!store.loading && !store.error && store.chain === "unavailable"}>
        <p role="alert" class="mt-3 text-[12px] font-[440] text-v2-state-fg-danger">
          {language.t("settings.computerUse.audit.chainUnverified")}
        </p>
      </Show>
      <Show when={!store.loading && !store.error && store.total > 0}>
        <p class="mt-3 text-[11px] font-[440] text-v2-text-text-faint">
          {store.verifiedThrough} / {store.total}
        </p>
      </Show>
      <Show when={!store.loading && !store.error && visible().length === 0}>
        <p class="mt-3 text-[13px] font-[440] text-v2-text-text-muted">
          {language.t("settings.computerUse.audit.empty")}
        </p>
      </Show>
      <For each={visible()}>
        {(entry) => (
          <div class="mt-3 flex flex-col gap-2 rounded-md border border-v2-border-border-muted p-3" data-testid="computer-use-audit-entry">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-[13px] font-[530] text-v2-text-text-base">
                  {entry.action}
                  <Show when={entry.target !== undefined}>
                    <span class="text-v2-text-text-muted">{` — ${entry.target}`}</span>
                  </Show>
                </p>
                <p class="mt-1 text-[11px] font-[440] text-v2-text-text-faint">
                  {timeLabel(entry.at)} · {entry.computerId}
                </p>
              </div>
              <span
                class="shrink-0 text-[11px] font-[530]"
                classList={{
                  "text-v2-state-fg-danger": entry.result.status !== "verified",
                  "text-v2-state-fg-success": entry.result.status === "verified",
                }}
              >
                {entry.result.status}
              </span>
            </div>
            <Show when={aimLine(copy, entry)}>
              {(line) => (
                <p
                  class="text-[11px] font-[440]"
                  classList={{
                    "text-v2-state-fg-warning": entry.aim?.strategy === "bounds-center",
                    "text-v2-text-text-muted": entry.aim?.strategy !== "bounds-center",
                  }}
                >
                  {line()}
                </p>
              )}
            </Show>
            <p class="text-[11px] font-[440] text-v2-text-text-muted">{targetLine(copy, entry)}</p>
            <Show when={evidenceLine(copy, entry)}>
              {(line) => <p class="text-[11px] font-[440] break-all text-v2-text-text-faint">{line()}</p>}
            </Show>
            <Show when={entry.result.reason !== undefined}>
              <p class="text-[11px] font-[440] text-v2-text-text-faint">
                {copy("settings.computerUse.audit.line.reason", { reason: entry.result.reason! })}
              </p>
            </Show>
          </div>
        )}
      </For>
    </section>
  )
}
