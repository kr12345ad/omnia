import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/session-ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import {
  computerUseAimIsGuess,
  computerUseCopy,
  computerUseOutcomeIsVerified,
  parseComputerUseApproval,
  type ComputerUseApproval,
  type ComputerUseCopyKey,
  type ComputerUseOutcome,
  type ComputerUseTarget,
} from "@/computer-use"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"

type Copy = (key: ComputerUseCopyKey, params?: Record<string, string | number>) => string

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()
  const permission = usePermission()
  const platform = usePlatform()

  const copy: Copy = (key, params) =>
    computerUseCopy((id, values) => language.t(id as Parameters<typeof language.t>[0], values), key, params)

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  const approval = createMemo(() =>
    parseComputerUseApproval({ permission: props.request.permission, metadata: props.request.metadata }),
  )

  // The control is read back from the local driver before the human decides, so
  // the dock reports the role, name and aim point the action will really use
  // rather than the query the model asked for.
  const [resolution, setResolution] = createStore({ target: undefined as ComputerUseTarget | undefined })

  createEffect(() => {
    const input = approval()
    const resolve = platform.computerUse?.resolveTarget
    const ref = input?.target.ref
    if (input === undefined || ref === undefined || resolve === undefined) {
      setResolution("target", undefined)
      return
    }
    let live = true
    onCleanup(() => {
      live = false
    })
    void resolve({ ref, app: input.app })
      .then((target) => {
        if (live) setResolution("target", target)
      })
      .catch(() => {
        if (live) setResolution("target", undefined)
      })
  })

  const target = createMemo<ComputerUseTarget>(() => {
    const declared = approval()?.target
    if (declared === undefined) return {}
    const resolved = resolution.target
    if (resolved === undefined) return declared
    return {
      ref: resolved.ref ?? declared.ref,
      role: resolved.role ?? declared.role,
      name: resolved.name ?? declared.name,
      application: resolved.application ?? declared.application,
      bounds: resolved.bounds ?? declared.bounds,
      aim: resolved.aim ?? declared.aim,
    }
  })

  const outcome = createMemo(() => permission.computerUseOutcome(props.request.sessionID))

  // The highlight is opt-in and local: only the computer-use block asks for it,
  // and it is dropped as soon as the pending item loses hover or focus.
  const showTarget = () => {
    const at = target()
    if (at.bounds === undefined) return
    void platform.computerUse
      ?.preview?.({ ref: at.ref, role: at.role, name: at.name, bounds: at.bounds, aim: at.aim })
      ?.catch(() => undefined)
  }

  const hideTarget = () => {
    void platform.computerUse?.clearPreview?.()?.catch(() => undefined)
  }

  onCleanup(hideTarget)

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Button
              variant="secondary"
              size="normal"
              onClick={() => props.onDecide("always")}
              disabled={props.responding}
            >
              {language.t("ui.permission.allowAlways")}
            </Button>
            <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.patterns}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>

      <Show when={approval()}>
        {(entry) => (
          <ComputerUseApproval
            approval={entry()}
            target={target()}
            guess={computerUseAimIsGuess(target().aim)}
            preview={platform.computerUse?.preview !== undefined}
            outcome={outcome()}
            copy={copy}
            onPreview={showTarget}
            onPreviewEnd={hideTarget}
          />
        )}
      </Show>
    </DockPrompt>
  )
}

function ComputerUseApproval(props: {
  approval: ComputerUseApproval
  target: ComputerUseTarget
  guess: boolean
  preview: boolean
  outcome: ComputerUseOutcome | undefined
  copy: Copy
  onPreview: () => void
  onPreviewEnd: () => void
}) {
  const aim = () => props.target.aim
  const known = () => props.target.ref !== undefined || props.target.name !== undefined || props.target.role !== undefined

  return (
    <div
      data-slot="permission-computer-use"
      class="flex flex-col gap-1.5 mt-2"
      onPointerEnter={props.onPreview}
      onPointerLeave={props.onPreviewEnd}
      onFocusIn={props.onPreview}
      onFocusOut={props.onPreviewEnd}
    >
      <Row label={props.copy("target.action")} value={props.approval.action ?? props.approval.operation} mono />
      <Show when={props.approval.query !== undefined}>
        <Row label={props.copy("target.query")} value={props.approval.query!} mono />
      </Show>
      <Show when={props.approval.app !== undefined}>
        <Row label={props.copy("target.application")} value={props.approval.app!} mono />
      </Show>
      <Row label={props.copy("target.ref")} value={props.target.ref ?? "—"} mono />
      <Row label={props.copy("target.role")} value={props.target.role ?? "—"} mono />
      <Row label={props.copy("target.name")} value={props.target.name ?? "—"} />
      <Show
        when={aim() !== undefined}
        fallback={
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-hint" class="text-text-weak">
              {props.copy("target.point")}: —
            </div>
          </div>
        }
      >
        <Row
          label={props.copy("target.point")}
          value={props.copy("target.pointValue", { x: aim()!.x, y: aim()!.y, strategy: aim()!.strategy })}
          mono
        />
      </Show>

      <Show when={props.guess}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <span
            data-slot="permission-guess-badge"
            class="self-start rounded-[4px] border border-icon-warning-base/40 px-1.5 py-0.5 text-11-regular font-[530] text-icon-warning-base"
          >
            {props.copy("guess.badge")}
          </span>
        </div>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint" class="text-text-weak">
            {props.copy("guess.explain")}
          </div>
        </div>
      </Show>

      <Show when={props.target.bounds === undefined || !known()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint" class="text-text-weak">
            {props.copy("target.unresolved")}
          </div>
        </div>
      </Show>

      <Show
        when={props.target.bounds !== undefined && props.preview}
        fallback={
          <Show when={props.target.bounds !== undefined && !props.preview}>
            <div data-slot="permission-row">
              <span data-slot="permission-spacer" aria-hidden="true" />
              <div data-slot="permission-hint" class="text-text-weak">
                {props.copy("preview.unavailable")}
              </div>
            </div>
          </Show>
        }
      >
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-preview" class="text-text-weak">
            <span class="text-12-regular font-[530] text-text-base">{props.copy("preview.label")}</span>
            {" — "}
            {props.copy("preview.hint")}
          </div>
        </div>
      </Show>

      <Show when={props.outcome !== undefined}>
        <Outcome outcome={props.outcome!} copy={props.copy} />
      </Show>
    </div>
  )
}

function Outcome(props: { outcome: ComputerUseOutcome; copy: Copy }) {
  const icon = () => {
    if (computerUseOutcomeIsVerified(props.outcome)) return "check" as const
    if (props.outcome.status === "failed") return "circle-ban-sign" as const
    return "warning" as const
  }
  const tone = () => {
    if (computerUseOutcomeIsVerified(props.outcome)) return "text-icon-success-base"
    if (props.outcome.status === "failed") return "text-icon-critical-base"
    return "text-icon-warning-base"
  }
  const label = () => {
    const copy = props.copy
    if (props.outcome.status === "verified") return copy("outcome.verified")
    if (props.outcome.status === "not_verified") return copy("outcome.notVerified")
    if (props.outcome.status === "failed") return copy("outcome.failed")
    return copy("outcome.unverified")
  }

  return (
    <div data-slot="permission-row" class="mt-1">
      <span data-slot="permission-spacer" aria-hidden="true" />
      <div data-slot="permission-outcome" class="flex flex-col gap-1">
        <div class="flex items-center gap-1.5">
          <Icon name={icon()} size="small" class={tone()} />
          <span class="text-12-regular text-text-base">
            {props.copy("outcome.section")}: {label()}
          </span>
        </div>
        <Show when={props.outcome.action !== undefined}>
          <span class="text-11-regular text-text-weak">
            {props.outcome.action}
            {props.outcome.targetName === undefined ? "" : ` · ${props.outcome.targetName}`}
          </span>
        </Show>
        <Show
          when={props.outcome.observed !== undefined}
          fallback={<span class="text-11-regular text-text-weak">{props.copy("outcome.none")}</span>}
        >
          <span class="text-11-regular text-text-weak whitespace-pre-wrap break-words">
            {props.copy("outcome.observed")}: {props.outcome.observed}
          </span>
        </Show>
      </div>
    </div>
  )
}

function Row(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div data-slot="permission-row">
      <span data-slot="permission-spacer" aria-hidden="true" />
      <div data-slot="permission-hint" class="flex gap-2 min-w-0">
        <span class="shrink-0 text-text-weak">{props.label}</span>
        <span
          class="min-w-0 break-all"
          classList={{ "font-mono text-12-regular text-text-base": props.mono === true }}
        >
          {props.value}
        </span>
      </div>
    </div>
  )
}
