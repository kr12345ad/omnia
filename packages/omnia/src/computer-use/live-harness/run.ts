// Live harness CLI: the only place in the repo that builds real desktop
// adapters.
//
// Two gates, both explicit. The arm (OMNIA_LIVE_HARNESS=1) is what allows a
// driver to be constructed at all, and without a DISPLAY there is nothing to
// act on, so an unarmed or displayless run prints a skip and exits 0. The
// harness never synthesises input on its own and never fabricates a result it
// did not observe.
//
// When armed, every trial performs real actions on the desktop it finds: the
// focus trial focuses a window, the wrong-target trial clicks a title-bar
// control, the honest-verify trial writes a control's current value back and
// then focuses it, and the stale-ref trial only ever gets its click refused.
// Point it at a scratch window, not at work.
import { createCuaHostDriver, type CuaHostDriver } from "../../cua/host-driver"
import type { ActionResult, ComputerAction, ElementReference, JsonValue, Observation, UIElement } from "../../protocol"
import {
  findWindow,
  resolveElement,
  type HarnessAct,
  type HarnessAdapters,
  type HarnessElement,
  type HarnessObservation,
  type HarnessObserve,
  type HarnessRequest,
  type HarnessResponse,
} from "./adapter"
import { liveHarnessSkipReason } from "./desktop-gate"
import { FOCUS_TRIAL_TITLE, runAllTrials, WRONG_TARGET_CONTROL_NAME, type HarnessReport } from "./index"

// The window the trials target, overridable so a live run can be pointed at a
// scratch window instead of the documented Kitty repro.
export const WINDOW_ENV = "OMNIA_LIVE_HARNESS_WINDOW"
export const CONTROL_ENV = "OMNIA_LIVE_HARNESS_CONTROL"

export function harnessWindowTitle(env: Readonly<Record<string, string | undefined>>): string {
  const title = env[WINDOW_ENV]
  return title === undefined || title.trim().length === 0 ? FOCUS_TRIAL_TITLE : title.trim()
}

export function harnessControlName(env: Readonly<Record<string, string | undefined>>): string {
  const control = env[CONTROL_ENV]
  return control === undefined || control.trim().length === 0 ? WRONG_TARGET_CONTROL_NAME : control.trim()
}

export function formatReport(report: HarnessReport): string {
  const skipped = report.trials.length - report.passed - report.failed - report.errors
  return [
    `live-harness: ${report.passed} pass, ${report.failed} fail, ${report.errors} error, ${skipped} skipped (pass rate ${Math.round(report.passRate * 100)}%)`,
    ...report.trials.map((trial) => `  ${trial.outcome.padEnd(8, " ")} ${trial.name} — ${trial.detail}`),
  ].join("\n")
}

// The real adapters. Returns undefined unless the harness is armed, so an
// unarmed process can never construct a driver, let alone move a pointer.
export function createLiveAdapters(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HarnessAdapters | undefined {
  if (liveHarnessSkipReason(env) !== undefined) return undefined
  let host: CuaHostDriver | undefined
  // Lazy so nothing reaches the display until a trial actually reads or acts.
  const driver = (): CuaHostDriver => {
    host ??= createCuaHostDriver()
    return host
  }
  const observe: HarnessObserve = async (request) => {
    const current = driver()
    if (request?.fresh === true) current.engine.invalidate()
    return toHarnessObservation(await current.observe())
  }
  const act: HarnessAct = async (request) => actOn(driver(), request)
  return { act, observe }
}

function numberOrUndefined(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function valueText(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined
  return typeof value === "string" ? value : JSON.stringify(value)
}

function toHarnessElement(element: UIElement): HarnessElement {
  const value = valueText(element.value)
  return {
    ref: element.id ?? "",
    ...(element.name === undefined ? {} : { name: element.name }),
    ...(element.role === undefined ? {} : { role: element.role }),
    ...(element.text === undefined ? {} : { text: element.text }),
    ...(value === undefined ? {} : { value }),
    ...(element.bounds === undefined
      ? {}
      : {
          bounds: {
            x: element.bounds.x,
            y: element.bounds.y,
            width: element.bounds.width,
            height: element.bounds.height,
          },
        }),
    ...(element.states === undefined ? {} : { states: [...element.states] }),
  }
}

function toHarnessElements(observation: Observation): readonly HarnessElement[] {
  return (observation.elements ?? []).flatMap((element) => (element.id === undefined ? [] : [toHarnessElement(element)]))
}

function activeWindowTitle(observation: Observation): string | undefined {
  return (observation.elements ?? []).find(
    (element) => element.role === "window" && (element.states ?? []).includes("focused"),
  )?.name
}

function toHarnessObservation(observation: Observation): HarnessObservation {
  const screen = observation.screen
  const generation = numberOrUndefined(observation.metadata?.generation)
  const title = activeWindowTitle(observation)
  return {
    ...(observation.id === undefined ? {} : { observationId: observation.id }),
    ...(generation === undefined ? {} : { generation }),
    ...(title === undefined ? {} : { activeWindowTitle: title }),
    ...(screen === undefined || screen.width <= 0 || screen.height <= 0
      ? {}
      : { screen: { width: screen.width, height: screen.height } }),
    elements: toHarnessElements(observation),
  }
}

// The binding the act is judged against: whatever the caller supplied (a stale
// binding is the stale-ref trial's whole point), otherwise the observation this
// act was resolved against.
function bindingOf(observation: Observation, request: HarnessRequest, elementId: string): ElementReference {
  const generation = numberOrUndefined(observation.metadata?.generation)
  const supplied = request.observationId !== undefined || request.generation !== undefined
  return {
    kind: "element",
    elementId,
    ...(supplied
      ? {
          ...(request.observationId === undefined ? {} : { observationId: request.observationId }),
          ...(request.generation === undefined ? {} : { generation: request.generation }),
        }
      : {
          ...(observation.id === undefined ? {} : { observationId: observation.id }),
          ...(generation === undefined ? {} : { generation }),
        }),
  }
}

function actionFor(observation: Observation, elements: readonly HarnessElement[], request: HarnessRequest) {
  const resolved = request.kind === "focus" ? findWindow(elements, request.name) : resolveElement(elements, request.name)
  const elementId = request.ref ?? resolved?.ref
  if (elementId === undefined || elementId.length === 0) return undefined
  const target = { kind: "element", elementId, reference: bindingOf(observation, request, elementId) } as const
  if (request.kind === "focus") return { type: "focus", target } satisfies ComputerAction
  if (request.kind === "click") return { type: "click", target } satisfies ComputerAction
  return { type: "setvalue", value: request.value ?? "", target } satisfies ComputerAction
}

async function actOn(host: CuaHostDriver, request: HarnessRequest): Promise<HarnessResponse> {
  const observation = await host.observe()
  const action = actionFor(observation, toHarnessElements(observation), request)
  if (action === undefined) {
    return { ok: false, detail: `the observation has no target named "${request.name}" for ${request.kind}` }
  }
  const result = await host.execute(action)
  const clicked = await clickedPoint(host, result)
  return {
    ok: result.success,
    ...(clicked === undefined ? {} : { clicked }),
    claimed: result.verification?.verified === true ? "verified" : "not_verified",
    ...(result.status === "rejected" ? { refused: refusalOf(result) } : {}),
    ...(result.message === undefined ? {} : { detail: result.message }),
  }
}

// Only a pointer delivery moved the mouse. The point the harness judges is the
// position the driver reports afterwards, so a background/invoke delivery —
// which never touched the pointer — records no click rather than claiming one.
async function clickedPoint(host: CuaHostDriver, result: ActionResult) {
  if (result.metadata?.delivery !== "pointer") return undefined
  const position = await host.pointerPosition()
  if (typeof position.x !== "number" || typeof position.y !== "number") return undefined
  return { x: position.x, y: position.y }
}

function refusalOf(result: ActionResult): string {
  const error = result.error
  if (typeof error === "string") return error
  return error?.message ?? result.message ?? "the tool refused the target"
}

export async function main(env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  const skip = liveHarnessSkipReason(env)
  const adapters = skip === undefined ? createLiveAdapters(env) : undefined
  if (adapters === undefined) {
    console.log(`skip: no desktop (${skip})`)
    return 0
  }
  const report = await runAllTrials({
    ...adapters,
    env,
    title: harnessWindowTitle(env),
    controlName: harnessControlName(env),
  })
  console.log(formatReport(report))
  return report.failed + report.errors === 0 ? 0 : 1
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
}
