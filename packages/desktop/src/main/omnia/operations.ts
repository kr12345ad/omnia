import type { CapabilitySupport, FindResult, Observation } from "@opencode-ai/omnia/protocol"
import type { OmniaDriverRegistry } from "./registry"
import {
  isOmniaPayloadWithinSize,
  isOmniaPermissionId,
  isRecord,
  OMNIA_MAX_RESULT_BYTES,
  parseOmniaActionResult,
  parseOmniaCapabilities,
  parseOmniaComputerInfo,
  parseOmniaFindResult,
  parseOmniaObservation,
  parseOmniaTargetReference,
  withOmniaTarget,
} from "./validation"
import {
  OMNIA_BLOCKED_REASONS,
  OMNIA_UNAVAILABLE_REASONS,
  OmniaDriverError,
  type OmniaAwaitable,
  type OmniaCapabilities,
  type OmniaDriver,
  type OmniaExecuteRequest,
  type OmniaExecution,
  type OmniaFailure,
  type OmniaFindRequest,
  type OmniaObserveRequest,
  type OmniaResult,
  type OmniaTargetReference,
} from "./types"

export function createOmniaOperations(registry: OmniaDriverRegistry) {
  return {
    getCapabilities: () => getCapabilities(registry),
    observe: (request: OmniaObserveRequest) => observe(registry, request),
    find: (request: OmniaFindRequest) => find(registry, request),
    execute: (request: OmniaExecuteRequest) => execute(registry, request),
  }
}

async function getCapabilities(registry: OmniaDriverRegistry): Promise<OmniaResult<OmniaCapabilities>> {
  const driver = registry.get()
  if (!driver) return unavailable("driver_unavailable")
  const capabilities = mapValue(driver.capabilities ?? [], parseOmniaCapabilities)
  if (capabilities.status !== "ok") return capabilities
  const info = driver.getInfo
    ? await callValue(() => driver.getInfo!()).then((result) =>
        result.status === "ok" ? mapValue(result.value, parseOmniaComputerInfo) : result,
      )
    : ({ ok: true, status: "ok", value: null } as const)
  if (info.status !== "ok") return info
  const operations = {
    observe: typeof driver.observe === "function",
    find: typeof driver.find === "function",
    execute: typeof driver.execute === "function" && typeof driver.revalidateTarget === "function",
    subscribe: typeof driver.subscribe === "function",
  }
  return {
    ok: true,
    status: "ok",
    value: {
      id: driver.id,
      backend: driver.backend,
      platform: info.value?.platform ?? registry.platform,
      available: info.value?.connected !== false && Object.values(operations).some(Boolean),
      computer: info.value,
      operations,
      capabilities: capabilities.value,
    },
  }
}

async function observe(registry: OmniaDriverRegistry, request: OmniaObserveRequest): Promise<OmniaResult<Observation>> {
  const driver = registry.get()
  if (!driver) return unavailable("driver_unavailable")
  if (!driver.observe) return unavailable()
  const permission = permissionFailure(
    driver,
    request.includeScreenshot ? ["observe", "screenshot", "screen-capture"] : ["observe", "accessibility-tree"],
  )
  if (permission) return permission
  const result = await callValue(() => driver.observe!(request))
  if (result.status !== "ok") return result
  return mapValue(result.value, parseOmniaObservation)
}

async function find(registry: OmniaDriverRegistry, request: OmniaFindRequest): Promise<OmniaResult<FindResult>> {
  const driver = registry.get()
  if (!driver) return unavailable("driver_unavailable")
  if (!driver.find) return unavailable()
  const permission = permissionFailure(driver, ["find", "accessibility-tree"])
  if (permission) return permission
  const result = await callValue(() => driver.find!(request))
  if (result.status !== "ok") return result
  return mapValue(result.value, parseOmniaFindResult)
}

async function execute(
  registry: OmniaDriverRegistry,
  request: OmniaExecuteRequest,
): Promise<OmniaResult<OmniaExecution>> {
  const driver = registry.get()
  if (!driver) return unavailable("driver_unavailable")
  if (!driver.execute || !driver.revalidateTarget) return unavailable()
  const permission = permissionFailure(driver, actionCapabilities(request))
  if (permission) return permission
  const revalidation = await callValue(() => driver.revalidateTarget!(request.target))
  if (revalidation.status !== "ok") return revalidation
  const unwrapped = unwrapResult(revalidation.value)
  if (unwrapped.status !== "ok") return unwrapped
  const target = mapValue(unwrapped.value, parseOmniaTargetReference)
  if (target.status !== "ok") return target
  if (!sameTarget(request.target, target.value)) return blocked("target_stale")
  const result = await callValue(() => driver.execute!(withOmniaTarget(request.action, target.value)))
  if (result.status !== "ok") return result
  const actionResult = mapValue(result.value, parseOmniaActionResult)
  if (actionResult.status !== "ok") return actionResult
  if (actionResult.value.status === "unavailable") return unavailable()
  if (actionResult.value.status === "error") {
    const permission = resultPermission(driver, actionResult.value.error, actionResult.value.limitations)
    return permission ?? blocked("driver_blocked")
  }
  if (!actionResult.value.success) {
    const permission = resultPermission(driver, actionResult.value.error, actionResult.value.limitations)
    return permission ?? blocked("driver_blocked")
  }
  return { ok: true, status: "ok", value: { target: target.value, result: actionResult.value } }
}

function sameTarget(expected: OmniaTargetReference, actual: OmniaTargetReference) {
  return (
    expected.elementId === actual.elementId &&
    expected.generation === actual.generation &&
    expected.observationId === actual.observationId &&
    expected.source === actual.source &&
    expected.backend === actual.backend
  )
}

function actionCapabilities(request: OmniaExecuteRequest) {
  if (
    request.action.type === "click" ||
    request.action.type === "doubleclick" ||
    request.action.type === "rightclick"
  ) {
    return ["mouse", "pointer"]
  }
  if (request.action.type === "type") return ["text-input", "keyboard"]
  if (request.action.type === "key") return ["keyboard", "input"]
  if (request.action.type === "scroll") return ["scroll", "pointer"]
  return ["focus", "application-focus"]
}

function permissionFailure(driver: OmniaDriver, capabilities: string[]) {
  const permission = requiredPermission(driver.capabilities ?? [], capabilities)
  if (!permission) return
  return {
    ok: false,
    status: "permission_required",
    permission: permission.id,
    canRequest: permission.promptable ?? permission.status === "prompt",
  } as const
}

function resultPermission(driver: OmniaDriver, error: unknown, limitations: readonly { kind: string }[] | undefined) {
  const permissionCode = isRecordError(error) && error.code === "permission_required"
  if (!permissionCode && !limitations?.some((limitation) => limitation.kind === "permission")) return
  return permissionFailure(driver, [])
}

function requiredPermission(capabilities: readonly CapabilitySupport[], requested: readonly string[]) {
  return capabilities
    .flatMap((capability) => capability.permissions ?? [])
    .find(
      (permission) =>
        (permission.status === "prompt" ||
          permission.status === "denied" ||
          permission.status === "restricted" ||
          permission.status === "unknown") &&
        (requested.length === 0 || permission.capabilities?.some((capability) => requested.includes(capability))),
    )
}

function isRecordError(value: unknown): value is { code: string } {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
}

function unwrapResult(value: unknown): { ok: true; status: "ok"; value: unknown } | OmniaFailure {
  if (isOmniaFailure(value)) return value
  if (!isRecord(value) || value.ok !== true || value.status !== "ok" || !("value" in value)) {
    return blocked("invalid_result")
  }
  return { ok: true, status: "ok", value: value.value }
}

async function callValue<T>(operation: () => OmniaAwaitable<T>) {
  try {
    return { ok: true, status: "ok", value: await operation() } as OmniaResult<T>
  } catch (error) {
    if (error instanceof OmniaDriverError) return error.failure
    return blocked("operation_failed")
  }
}

function mapValue<T>(value: unknown, parse: (value: unknown) => T): OmniaResult<T> {
  if (!isOmniaPayloadWithinSize(value, OMNIA_MAX_RESULT_BYTES)) return blocked("result_too_large")
  try {
    return { ok: true, status: "ok", value: parse(value) }
  } catch {
    return blocked("invalid_result")
  }
}

function unavailable(reason: (typeof OMNIA_UNAVAILABLE_REASONS)[number] = "operation_unavailable") {
  return { ok: false, status: "unavailable", reason } as const
}

function blocked(reason: (typeof OMNIA_BLOCKED_REASONS)[number]) {
  return { ok: false, status: "blocked", reason } as const
}

export function isOmniaFailure(value: unknown): value is OmniaFailure {
  if (typeof value !== "object" || value === null || !("ok" in value) || value.ok !== false) return false
  if (!("status" in value) || typeof value.status !== "string") return false
  if (value.status === "unavailable") {
    return (
      "reason" in value &&
      typeof value.reason === "string" &&
      (OMNIA_UNAVAILABLE_REASONS as readonly string[]).includes(value.reason)
    )
  }
  if (value.status === "blocked") {
    return (
      "reason" in value &&
      typeof value.reason === "string" &&
      (OMNIA_BLOCKED_REASONS as readonly string[]).includes(value.reason)
    )
  }
  return (
    value.status === "permission_required" &&
    "permission" in value &&
    isOmniaPermissionId(value.permission) &&
    "canRequest" in value &&
    typeof value.canRequest === "boolean"
  )
}
