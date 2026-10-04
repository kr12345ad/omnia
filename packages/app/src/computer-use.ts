export type ComputerUseModelState =
  | "NOT_INSTALLED"
  | "DOWNLOADING"
  | "INSTALLED"
  | "STARTING"
  | "READY"
  | "LOADING"
  | "UNLOADING"
  | "FAILED"
  | "DISABLED"

export interface ComputerUseModel {
  id: string
  displayName: string
  provider: string
  description?: string
  quantization?: string
  modelSizeBytes?: number
  recommended?: boolean
  enabled: boolean
}

export interface ComputerUseModelStatus {
  model: ComputerUseModel
  state: ComputerUseModelState
  installed: boolean
  loaded: boolean
  progress?: number
  bytesOnDisk?: number
  runtimeBackend?: string
  reason?: string
}

export interface ComputerUseStatus {
  mode: string
  installedModels: number
  localRuntime: {
    available: boolean
    command?: string
    backend?: string
    reason?: string
  }
}

export interface ComputerUseSettings {
  allowDownloads: boolean
  mode: string
  allowRemoteScreen?: boolean
}

export interface ComputerUseRuntimeStatus {
  runtime: {
    id: string
    variant: "cpu" | "cuda" | "rocm" | "vulkan" | "metal"
    displayName: string
    description?: string
    backend: string
  }
  state: ComputerUseModelState
  installed: boolean
  bundled: boolean
  progress?: number
  bytes?: number
  bytesOnDisk?: number
  reason?: string
}

export interface ComputerUseCalibrationProfile {
  screen: { width: number; height: number }
  scaleX: number
  scaleY: number
  offsetX: number
  offsetY: number
  samples: number
  measuredAt: number
}

export interface ComputerUseCalibrationPoint {
  id: string
  x: number
  y: number
}

export interface ComputerUseCalibrationMeasurement {
  pointId: string
  x: number
  y: number
  observedX?: number
  observedY?: number
  deltaX?: number
  deltaY?: number
  error?: string
}

export interface ComputerUseCalibrationStatus {
  profile?: ComputerUseCalibrationProfile
  screen?: { width: number; height: number }
  stale: boolean
  calibrated: boolean
}

export interface ComputerUsePlatform {
  models(): Promise<ComputerUseModelStatus[]>
  status(): Promise<ComputerUseStatus>
  settings(): Promise<ComputerUseSettings>
  updateSettings(patch: Partial<ComputerUseSettings>): Promise<ComputerUseSettings>
  download(id: string): Promise<boolean>
  load(id: string): Promise<ComputerUseModelStatus | undefined>
  unload(id: string): Promise<boolean>
  remove(id: string): Promise<boolean>
  runtimes(): Promise<ComputerUseRuntimeStatus[]>
  downloadRuntime(id: string): Promise<boolean>
  removeRuntime(id: string): Promise<boolean>
  calibration(): Promise<ComputerUseCalibrationStatus>
  calibrationStart(): Promise<{ screen: { width: number; height: number }; points: ComputerUseCalibrationPoint[] }>
  calibrationMeasure(pointId: string): Promise<ComputerUseCalibrationMeasurement>
  calibrationSave(measurements: ComputerUseCalibrationMeasurement[]): Promise<ComputerUseCalibrationProfile>
  calibrationReset(): Promise<boolean>
}
