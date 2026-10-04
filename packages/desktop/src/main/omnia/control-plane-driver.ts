// A desktop OmniaDriver that forwards protocol-shaped computer operations to
// the hosted control plane for the runtime this machine registered. It lets
// the existing operations/readiness/overlay code run unchanged as a thin
// client.
import type {
  ActionResult,
  CapabilitySupport,
  ComputerAction,
  ComputerInfo,
  ComputerTarget,
  FindRequest,
  FindResult,
  Observation,
  ObservationRequest,
} from "@opencode-ai/omnia/protocol"
import { controlPlaneCall } from "./control-plane"
import type { OmniaDriver, OmniaResult, OmniaTargetReference } from "./types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function targetFields(target: ComputerTarget | undefined): Record<string, unknown> {
  if (target === undefined) return {}
  if (target.kind === "point") return { x: target.x, y: target.y }
  if (target.kind === "application") return { app: target.applicationId }
  return {
    target: {
      kind: "element",
      elementId: target.elementId,
      ...(target.reference?.observationId === undefined ? {} : { observationId: target.reference.observationId }),
    },
  }
}

// The server's /actions route takes a named action plus flat fields; this is
// the inverse of the server's toComputerAction mapping for the actions the
// desktop UI emits.
function toServerAction(action: ComputerAction): Record<string, unknown> {
  const type = action.type
  if (type === "observe") return { action: "observe", ...(action.applicationId === undefined ? {} : { applicationId: action.applicationId }) }
  if (type === "screenshot") return { action: "screenshot", ...(action.region === undefined ? {} : { region: action.region }) }
  if (type === "find") {
    return {
      action: "find",
      query: action.request.query,
      ...(action.request.role === undefined ? {} : { role: action.request.role }),
      ...(action.request.name === undefined ? {} : { name: action.request.name }),
      ...(action.request.window === undefined ? {} : { window: action.request.window }),
      ...(action.request.limit === undefined ? {} : { limit: action.request.limit }),
    }
  }
  if (type === "click" || type === "doubleclick" || type === "rightclick") {
    return {
      action: type,
      ...targetFields(action.target),
      ...(action.button === undefined ? {} : { button: action.button }),
      ...("count" in action && action.count !== undefined ? { count: action.count } : {}),
      ...("modifiers" in action && action.modifiers !== undefined ? { keys: action.modifiers } : {}),
    }
  }
  if (type === "move" || type === "longpress") return { action: "move", ...targetFields(action.target) }
  if (type === "drag") return { action: "drag", from: action.from, to: action.to, ...(action.button === undefined ? {} : { button: action.button }) }
  if (type === "type") return { action: "type", text: action.text, ...targetFields(action.target) }
  if (type === "setvalue") return { action: "set_value", text: typeof action.value === "string" ? action.value : JSON.stringify(action.value), ...targetFields(action.target) }
  if (type === "key") return { action: "key", key: action.key, ...targetFields(action.target) }
  if (type === "keypress") return { action: "key", key: action.key }
  if (type === "press" || type === "press_keys") return { action: "key", key: action.keys }
  if (type === "scroll") {
    return {
      action: "scroll",
      ...(action.direction === undefined ? {} : { direction: action.direction }),
      ...(action.amount === undefined ? {} : { amount: action.amount }),
      ...targetFields(action.target),
    }
  }
  if (type === "focus") return { action: "focus", ...targetFields(action.target) }
  if (type === "toggle") return { action: "toggle", ...targetFields(action.target) }
  if (type === "select") {
    return {
      action: "select",
      text: typeof action.value === "string" ? action.value : JSON.stringify(action.value ?? ""),
      ...targetFields(action.target),
    }
  }
  if (type === "expand") return { action: "expand", ...targetFields(action.target) }
  if (type === "collapse") return { action: "collapse", ...targetFields(action.target) }
  if (type === "increment") return { action: "increment", ...targetFields(action.target) }
  if (type === "decrement") return { action: "decrement", ...targetFields(action.target) }
  if (type === "scroll_into_view") return { action: "scroll_into_view", ...targetFields(action.target) }
  if (type === "dismiss") return { action: "dismiss" }
  if (type === "wait") return { action: "wait", ...(action.ms === undefined ? {} : { amount: action.ms }) }
  if (type === "read") return { action: "read_text", ...targetFields(action.target) }
  if (type === "launch") return { action: "launch", app: action.applicationId }
  if (type === "open") return { action: "open", url: action.target }
  if (type === "close") return { action: "close", ...targetFields(action.target) }
  if (type === "copy") return { action: "copy", ...targetFields(action.target) }
  if (type === "paste") return { action: "paste", ...(action.text === undefined ? {} : { text: action.text }) }
  return { action: type }
}

export function createControlPlaneDriver(input: {
  readonly computerId: string
  readonly capabilities: readonly CapabilitySupport[]
}): OmniaDriver {
  const base = `/v1/computers/${encodeURIComponent(input.computerId)}`
  return {
    id: input.computerId,
    backend: "remote",
    get capabilities() {
      return input.capabilities
    },
    getInfo: async (): Promise<ComputerInfo> => {
      const json = await controlPlaneCall("/v1/computers", "GET")
      const computers = Array.isArray(json.computers) ? json.computers : []
      const computer = computers.find((entry) => isRecord(entry) && entry.id === input.computerId)
      if (computer === undefined) throw new Error(`The control plane no longer lists ${input.computerId}.`)
      return computer as unknown as ComputerInfo
    },
    observe: async (request?: ObservationRequest): Promise<Observation> => {
      const json = await controlPlaneCall(`${base}/observe`, "POST", request ?? {})
      if (!isRecord(json.observation)) throw new Error("The control plane returned no observation.")
      return json.observation as unknown as Observation
    },
    find: async (request: FindRequest): Promise<FindResult> => {
      const json = await controlPlaneCall(`${base}/find`, "POST", request)
      return (isRecord(json.result) ? json.result : {}) as unknown as FindResult
    },
    execute: async (action: ComputerAction): Promise<ActionResult> => {
      const json = await controlPlaneCall(`${base}/actions`, "POST", toServerAction(action))
      if (!isRecord(json.result)) throw new Error("The control plane returned no action result.")
      return json.result as unknown as ActionResult
    },
    revalidateTarget: async (target: OmniaTargetReference): Promise<OmniaResult<OmniaTargetReference>> => ({
      ok: true,
      status: "ok",
      value: target,
    }),
  }
}
