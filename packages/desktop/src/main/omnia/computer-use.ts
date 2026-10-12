import { ipcMain } from "electron"
import { computeAim } from "@opencode-ai/omnia/computer-use/aim"
import { controlPlaneCall } from "./control-plane"
import { createAgentTargetHighlight, type AgentTargetHighlight, type AgentTargetHighlightInput } from "./overlay"
import { getOmniaDriver } from "./registry"

function modelPath(id: string): string {
  return `/v1/computer-use/models/${encodeURIComponent(id)}`
}

// The dock asks the desktop to read a control back before the human approves it,
// so the approval surface can name the element and the aim point the action will
// really use. The read goes through the driver the action itself goes through,
// which is what keeps the aim shown here and the aim executed from disagreeing.
interface ResolveTargetInput {
  readonly ref?: string
  readonly app?: string
}

interface ResolvedTarget {
  readonly ref?: string
  readonly role?: string
  readonly name?: string
  readonly application?: string
  readonly bounds?: { x: number; y: number; width: number; height: number }
  readonly aim?: { x: number; y: number; strategy: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function boundsOf(value: unknown) {
  if (!isRecord(value)) return undefined
  const x = finite(value.x)
  const y = finite(value.y)
  const width = finite(value.width)
  const height = finite(value.height)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  return { x, y, width, height }
}

function pointOf(value: unknown): { x: number; y: number } | undefined {
  if (!isRecord(value)) return undefined
  const x = finite(value.x)
  const y = finite(value.y)
  if (x === undefined || y === undefined) return undefined
  return { x, y }
}

function metadataOf(element: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(element.metadata) ? element.metadata : undefined
}

function refOf(element: Record<string, unknown>): string | undefined {
  const reference = isRecord(element.reference) ? element.reference : undefined
  return text(element.id) ?? text(element.ref) ?? text(reference?.elementId) ?? text(reference?.id)
}

function nameOf(element: Record<string, unknown>): string | undefined {
  return text(element.name) ?? text(element.accessibleName) ?? text(element.label)
}

function applicationOf(element: Record<string, unknown>): string | undefined {
  const metadata = metadataOf(element)
  return text(metadata?.application) ?? text(element.application)
}

function elementsOf(observation: unknown): Record<string, unknown>[] {
  if (!isRecord(observation) || !Array.isArray(observation.elements)) return []
  return observation.elements.filter(isRecord)
}

async function resolveTarget(input: ResolveTargetInput): Promise<ResolvedTarget | undefined> {
  const observe = getOmniaDriver()?.observe
  if (observe === undefined || input.ref === undefined) return undefined
  const observation = await observe(input.app === undefined ? {} : { applicationId: input.app })
  const elements = elementsOf(observation)
  // A ref either names a live element or it does not: falling back to a
  // similarly-named control would resolve something the action will not hit.
  const element = elements.find((entry) => refOf(entry) === input.ref)
  if (element === undefined) return undefined

  const bounds = boundsOf(element.bounds)
  const metadata = metadataOf(element)
  const role = text(element.role)
  const aim =
    bounds === undefined
      ? undefined
      : computeAim({
          bounds,
          role,
          focusPoint: pointOf(element.focusPoint) ?? pointOf(metadata?.focusPoint),
          aimHint: pointOf(element.aimHint) ?? pointOf(metadata?.aimHint),
        })
  return {
    ref: refOf(element),
    role,
    name: nameOf(element),
    application: applicationOf(element),
    bounds,
    aim: aim === undefined ? undefined : { x: aim.x, y: aim.y, strategy: aim.strategy },
  }
}

function previewRequest(input: unknown): AgentTargetHighlightInput | undefined {
  if (!isRecord(input)) return undefined
  const bounds = boundsOf(input.bounds)
  if (bounds === undefined) return undefined
  const aim = pointOf(input.aim)
  return {
    bounds,
    aim,
    guess: text(isRecord(input.aim) ? input.aim.strategy : undefined) === "bounds-center",
  }
}

export function registerComputerUseIpcHandlers(): void {
  const highlight: AgentTargetHighlight = createAgentTargetHighlight()

  ipcMain.handle("computer-use-models", async () => (await controlPlaneCall("/v1/computer-use/models", "GET")).models ?? [])
  ipcMain.handle("computer-use-status", async () => (await controlPlaneCall("/v1/computer-use/status", "GET")).status)
  ipcMain.handle("computer-use-settings", async () => (await controlPlaneCall("/v1/computer-use/settings", "GET")).settings)
  ipcMain.handle("computer-use-settings-update", async (_event, patch: unknown) => {
    const json = await controlPlaneCall("/v1/computer-use/settings", "POST", patch)
    return json.settings
  })
  ipcMain.handle("computer-use-model-download", async (_event, id: string) => {
    const json = await controlPlaneCall(`${modelPath(id)}/download`, "POST", {})
    return json.started === true
  })
  ipcMain.handle("computer-use-model-load", async (_event, id: string) => {
    const json = await controlPlaneCall(`${modelPath(id)}/load`, "POST", {})
    return json.model
  })
  ipcMain.handle("computer-use-model-unload", async (_event, id: string) => {
    const json = await controlPlaneCall(`${modelPath(id)}/unload`, "POST", {})
    return json.unloaded === true
  })
  ipcMain.handle("computer-use-model-remove", async (_event, id: string) => {
    const json = await controlPlaneCall(modelPath(id), "DELETE")
    return json.removed === true
  })
  ipcMain.handle("computer-use-runtimes", async () => (await controlPlaneCall("/v1/computer-use/runtimes", "GET")).runtimes ?? [])
  ipcMain.handle("computer-use-runtime-download", async (_event, id: string) => {
    const json = await controlPlaneCall(`/v1/computer-use/runtimes/${encodeURIComponent(id)}/download`, "POST", {})
    return json.started === true
  })
  ipcMain.handle("computer-use-runtime-remove", async (_event, id: string) => {
    const json = await controlPlaneCall(`/v1/computer-use/runtimes/${encodeURIComponent(id)}`, "DELETE")
    return json.removed === true
  })
  ipcMain.handle("computer-use-calibration", async () => (await controlPlaneCall("/v1/computer-use/calibration", "GET")).calibration)
  ipcMain.handle("computer-use-calibration-start", async () => {
    const json = await controlPlaneCall("/v1/computer-use/calibration/start", "POST", {})
    return { screen: json.screen, points: json.points }
  })
  ipcMain.handle("computer-use-calibration-measure", async (_event, pointId: string) => {
    const json = await controlPlaneCall("/v1/computer-use/calibration/measure", "POST", { pointId })
    return json.measurement
  })
  ipcMain.handle("computer-use-calibration-save", async (_event, measurements: unknown) => {
    const json = await controlPlaneCall("/v1/computer-use/calibration/save", "POST", { measurements })
    return json.profile
  })
  ipcMain.handle("computer-use-calibration-reset", async () => {
    await controlPlaneCall("/v1/computer-use/calibration", "DELETE")
    return true
  })

  // Read back the control a pending permission resolved to. A refusal is an
  // absent target, never a guess: the dock then reports the ref it was handed.
  ipcMain.handle("computer-use-resolve-target", async (_event, input: unknown) => {
    if (!isRecord(input)) return undefined
    const ref = text(input.ref)
    if (ref === undefined) return undefined
    try {
      return await resolveTarget({
        ref,
        ...(text(input.app) === undefined ? {} : { app: text(input.app) }),
      })
    } catch {
      return undefined
    }
  })
  // The highlight is drawn only while a hovered or focused computer-use
  // permission asks for it, and it is click-through and app-owned throughout.
  ipcMain.handle("computer-use-preview", async (_event, input: unknown) => {
    const request = previewRequest(input)
    if (request === undefined) return
    highlight.show(request)
  })
  ipcMain.handle("computer-use-preview-clear", async () => {
    highlight.hide()
  })
}
