// Metered screenshot streaming.
//
// A live view is a stream of frames from one computer, so the entitlement check
// belongs to the STREAM, not to the frame: opening the stream spends one unit
// of the live_view allowance and every frame after that is local capture. A
// per-frame check would either hammer the control plane or silently multiply
// the cost of watching a screen, and neither is what the allowance means.
//
// Nothing here decides what a plan may do; the gate asks the control plane and
// this file only turns a refusal into a typed error the transport can surface.
import type { ActionResult } from "../protocol"
import { EntitlementRefusedError, defaultEntitlementGate, type EntitlementDecision, type EntitlementGate } from "./entitlements"

/** The plan-matrix name for streaming a computer's screen. */
export const LIVE_VIEW_CAPABILITY = "live_view"

export interface LiveViewFrame {
  /** Zero-based position in this stream. */
  readonly index: number
  readonly capturedAt: number
  readonly result: ActionResult & { path?: string }
}

export interface LiveViewOptions {
  readonly gate?: EntitlementGate
  readonly now?: () => number
}

export type LiveViewCapture = () => Promise<ActionResult & { path?: string }>

/**
 * An open live-view stream and the single decision that admitted it.
 *
 * `open` is the only place a capability is checked. Frames are captured through
 * the driver's own screenshot path with no billing call at all, so a long stream
 * costs the same one unit as a single frame.
 */
export class CuaLiveView {
  readonly capability = LIVE_VIEW_CAPABILITY
  readonly decision: EntitlementDecision
  private readonly capture: LiveViewCapture
  private readonly now: () => number
  private frames = 0
  private closed = false

  private constructor(capture: LiveViewCapture, decision: EntitlementDecision, now: () => number) {
    this.capture = capture
    this.decision = decision
    this.now = now
  }

  /**
   * Opens a stream, or throws EntitlementRefusedError.
   *
   * This is the stream's only billing call. The decision it returns is the
   * lease every frame runs on, so however many frames are captured and however
   * long the stream lives, the stream costs exactly one unit of the allowance.
   */
  static async open(capture: LiveViewCapture, options: LiveViewOptions = {}): Promise<CuaLiveView> {
    const gate = options.gate ?? defaultEntitlementGate()
    const decision = await gate.authorize(LIVE_VIEW_CAPABILITY)
    return new CuaLiveView(capture, decision, options.now ?? Date.now)
  }

  get frameCount(): number {
    return this.frames
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** One frame. No entitlement call: the stream already paid for it. */
  async frame(): Promise<LiveViewFrame> {
    if (this.closed) throw new Error("The live view stream is closed.")
    const index = this.frames
    this.frames += 1
    return { index, capturedAt: this.now(), result: await this.capture() }
  }

  close(): void {
    this.closed = true
  }
}
