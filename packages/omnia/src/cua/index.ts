export {
  DEFAULT_SNAPSHOT_TTL_MS,
  CuaEngine,
  computeStateDelta,
  createBackend,
  elementByRef,
} from "./engine"
export type { CuaEngineOptions } from "./engine"
export { CuaHostDriver, createCuaHostDriver } from "./host-driver"
export type { CuaHostDriverOptions, CuaLegacyFallbacks } from "./host-driver"
export {
  ENTITLEMENT_OUTAGE_TTL_MS,
  ENTITLEMENT_TIMEOUT_MS,
  EntitlementGate,
  EntitlementRefusedError,
  createEntitlementGate,
  defaultEntitlementGate,
  isEntitlementRefusedError,
  setDefaultEntitlementGate,
} from "./entitlements"
export type { EntitlementDecision, EntitlementGateOptions, EntitlementOrigin } from "./entitlements"
export { CuaLiveView, LIVE_VIEW_CAPABILITY } from "./live-view"
export type { LiveViewCapture, LiveViewFrame, LiveViewOptions } from "./live-view"
export { createDarwinBackend } from "./backends/darwin"
export { createLinuxBackend } from "./backends/linux"
export type { LinuxCuaBackendOptions } from "./backends/linux"
export { createWindowsBackend } from "./backends/windows"
export type {
  CuaAction,
  CuaActionResult,
  CuaBackend,
  CuaCapabilities,
  CuaDelivery,
  CuaElement,
  CuaFindQuery,
  CuaPlatform,
  CuaSnapshot,
  CuaSnapshotOptions,
  CuaStateDelta,
  CuaWaitCondition,
  CuaWaitResult,
  CuaWindow,
} from "./types"
