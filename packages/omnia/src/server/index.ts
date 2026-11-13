export {
  EventBus,
  SERVER_EVENT_LIMIT,
  SERVER_EVENT_TYPES,
} from "./events"
export type { EventBusOptions, ServerEvent, ServerEventListener, ServerEventType } from "./events"
export {
  APPROVAL_POLICIES,
  DESTRUCTIVE_SCOPES,
  OMNIA_SCOPES,
  PERMISSION_STATES,
  PermissionManager,
  describePermissions,
  isOmniaScope,
  requiredScopesForAction,
} from "./permissions"
export type {
  ApprovalInput,
  ApprovalPolicy,
  OmniaScope,
  PermissionDecision,
  PermissionDescription,
  PermissionState,
} from "./permissions"
export {
  ComputerManager,
  computeStateDelta,
  sliceTypeText,
  verifyOutcome,
} from "./computers"
export {
  activeWindowIdFromObservation,
  focusedWindowFromObservation,
  focusedWindowName,
  isScreenCenterClick,
  isWrongTargetCenterClick,
  matchesWindowTitle,
  screenCenterFor,
  targetCenterOf,
  verifyFocusTrial,
  verifyWindowFocused,
  FOCUS_CENTER_TOLERANCE_PX,
  FOCUS_OFF_CENTER_DISTANCE_PX,
  REFERENCE_SCREEN_CENTER,
  KWIN_VERIFY_SETTLE_MS,
  parseKWinActiveWindow,
  parseKWinMinimized,
  parseX11ActiveWindow,
  parseX11Minimized,
  verifyFocusLoss,
  verifyWindowClosed,
  verifyWindowMinimized,
  verifyWindowState,
} from "./kwin-verify"
export type {
  BrowserController,
  BrowserElementSummary,
  BrowserPageSummary,
  BrowserStatusSummary,
  BrowserTabSummary,
  CommandRequest,
  CommandResult,
  Computer,
  ComputerManagerOptions,
  ComputerSummary,
  ExecuteContext,
  ExecuteOutcome,
  ManagedComputer,
  Revalidation,
  DragEndpoint,
  ServerActionRequest,
  ServerBatchRequest,
  ServerBatchStep,
  BatchResult,
  BatchStepResult,
  StepExpectation,
  ServerComputerDriver,
  StateDelta,
  TypeSlice,
  InputGrabEvent,
  InputGrabReleasedBy,
  InputFreezeOutcome,
  InputReleaseOutcome,
  InputStateOutcome,
} from "./computers"
export {
  OMNIA_API_PREFIX,
  OMNIA_API_VERSION,
  OMNIA_BODY_LIMIT_BYTES,
  OMNIA_PROTOCOL_VERSION,
  OMNIA_SSE_HEARTBEAT_MS,
} from "./api"
export type {
  ApiContext,
  ServerCatalog,
  ServerCatalogEntry,
  ServerDescriptor,
  ServerHealth,
  ServerHealthState,
  ServerSession,
  SubsystemHealth,
} from "./api"
export { OMNIA_ACTION_CATALOG } from "./catalog"
export { PairingManager, formatPairingCode, normalizePairingCode, parsePairingCode } from "../pairing"
export type { PairingOffer } from "../pairing"
export { RemoteComputerDriver, RemoteRegistry, parseRemotePublicKey } from "./remote"
export type {
  RemoteClaimInput,
  RemoteClaimResult,
  RemoteCommand,
  RemoteRegistryOptions,
  RemoteResultMessage,
} from "./remote"
export {
  parseActionScript,
  renderAnthropicTools,
  renderCatalogText,
  renderOpenAiTools,
  renderToolSchemas,
} from "./text-protocol"
export type { ParsedScript, ToolSchema } from "./text-protocol"
export type { ActionCatalogEntry } from "./catalog"
export { OMNIA_SERVER_VERSION, startOmniaServer } from "./server"
export type { OmniaGrpcOptions, OmniaServerHandle, OmniaServerOptions } from "./server"
export { startGrpcServer } from "./grpc"
export type {
  GnmiAccess,
  GnmiStateSource,
  GrpcServerHandle,
  GrpcServerOptions,
  GrpcTlsOptions,
} from "./grpc"
