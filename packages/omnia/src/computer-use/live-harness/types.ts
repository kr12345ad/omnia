export type TrialOutcome = "pass" | "fail" | "error" | "skipped"

export interface TrialResult {
  readonly name: string
  readonly outcome: TrialOutcome
  readonly detail: string
  readonly evidence?: Record<string, unknown>
}

export interface HarnessReport {
  readonly trials: readonly TrialResult[]
  readonly passed: number
  readonly failed: number
  readonly errors: number
  readonly passRate: number
}
