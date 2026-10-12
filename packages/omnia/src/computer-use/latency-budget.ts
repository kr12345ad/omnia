// Deterministic (non-inference) per-step latency budget for the computer-use
// step path.
//
// specs/v27/latency-harness.md:66-81 records a ~29s/step CPU heuristic with no
// first-token number for vision inference. That number is unusable for planning
// multi-step work: it says nothing about the half of a step that runs without a
// model. This module measures that half — snapshot, diff, ref resolution, aim,
// semantic match, act, verify — against synthetic desktops of 50/200/500/1000
// controls so the per-step cost is sized without waiting on inference.
//
// Everything here is measured, never estimated. The synthetic desktop is served
// by a real helper process over the same JSON-line protocol the AT-SPI helper
// uses (`daemon/persistent-helper.ts`), so every number includes the real
// process spawn, the real pipe transfer, and the real JSON decode the daemon
// performs. What is substituted is the pyatspi/DBus tree walk: the helper builds
// the same JSON tree in memory instead of asking the accessibility bus for it.
// The live walk on this host is measured separately by the test that uses the
// unmodified ATSPI_SCRIPT against the real display.

import { createJsonLineHelper, type PersistentHelper } from "../daemon/persistent-helper"
import type { RunResult, Runner } from "../daemon/linux"

/** The per-step budget this measurement is judged against. */
export const STEP_BUDGET_MS = 2000

/** Synthetic desktop sizes, in visible controls. */
export const DESKTOP_SIZES = [50, 200, 500, 1000] as const

export type DesktopSize = (typeof DESKTOP_SIZES)[number]

/** Discarded runs before any measurement, per scenario. */
export const WARMUP_RUNS = 3

/** Measured runs per scenario. */
export const MEASURED_RUNS = 15

/** The three per-step edits the post-action tree is compared against. */
export const CHANGED_CONTROLS = 3

/** The query the semantic-match leg runs against every desktop. */
export const MATCH_QUERY = "Control 3"

/**
 * Drop the driver's 350ms observation replay so every measured run is a fresh
 * capture. Without it each run after the first is a cache hit and the snapshot
 * leg measures nothing.
 */
export function invalidateSnapshot(driver: { invalidateObservation(): void }): void {
  driver.invalidateObservation()
}

export interface Timing {
  /** Median of the measured runs. */
  readonly medianMs: number
  readonly meanMs: number
  readonly minMs: number
  readonly maxMs: number
  readonly runs: number
}

/**
 * Median of `runs` measured executions after `WARMUP_RUNS` discarded warmups.
 *
 * A median rather than a mean: a scheduler stall on a loaded host is a property
 * of the host, and one 200ms outlier in a 5ms component must not read as the
 * component's cost.
 */
export async function measure(body: () => unknown, runs = MEASURED_RUNS): Promise<Timing> {
  for (let warmup = 0; warmup < WARMUP_RUNS; warmup += 1) await body()
  const samples: number[] = []
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now()
    await body()
    samples.push(performance.now() - started)
  }
  samples.sort((left, right) => left - right)
  const middle = Math.floor(samples.length / 2)
  return {
    medianMs: samples[middle] ?? 0,
    meanMs: samples.reduce((total, sample) => total + sample, 0) / Math.max(1, samples.length),
    minMs: samples[0] ?? 0,
    maxMs: samples[samples.length - 1] ?? 0,
    runs: samples.length,
  }
}

// Sub-millisecond components are the common case here; two decimals keeps a
// 0.04ms aim leg readable instead of collapsing it to 0.
export function round(value: number, places = 2): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

// The synthetic desktop served to the driver. It mirrors the structure one
// application exposes under AT-SPI — application root, one frame, panels of ten
// controls — and carries the same fields the real helper emits, so the
// driver-side normalization, hierarchy, and reference minting run unchanged.
//
// The three edits the post-action tree is compared against: Control 3 (a text
// box) takes a new value, Control 7 shifts 24px right, and Control 11 becomes
// selected. Nothing else differs between the two trees, so a diff that reports
// more than three changes is diffing something that did not change.
export const SYNTHETIC_DESKTOP_SCRIPT = `import json
import os
import sys

CONTROLS = int(os.environ.get("SYNTH_CONTROLS", "100"))
CHANGED = os.environ.get("SYNTH_CHANGED", "") == "1"

ROLES = ["push button", "text box", "check box", "static text", "scroll bar"]
ACTIONS = [["click"], ["press"], ["activate"], [], ["focus"]]


def emit(payload):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\\n")
    sys.stdout.flush()


def control(index):
    column = index % 20
    row = index // 20
    role = "text box" if index == 3 else ROLES[index % len(ROLES)]
    states = ["enabled"]
    if index == 5:
        states = ["enabled", "focused"]
    if CHANGED and index == 11:
        states = ["enabled", "focused", "selected"]
    x = 10 + column * 60
    if CHANGED and index == 7:
        x = x + 24
    return {
        "path": [0, 0, index // 10, index % 10],
        "role": role,
        "name": "Control %d" % index,
        "description": "control number %d of the synthetic desktop" % index,
        "text": "row %d of the synthetic desktop" % row,
        "value": ("typed value %d (edited)" % index) if (CHANGED and index == 3) else ("typed value %d" % index),
        "states": states,
        "actions": ACTIONS[index % len(ACTIONS)],
        "bounds": {"x": x, "y": 60 + row * 32, "width": 120, "height": 24},
        "children": [],
    }


def panel(start):
    return {
        "path": [0, 0, start // 10],
        "role": "panel",
        "name": "Panel %d" % (start // 10),
        "description": None,
        "text": None,
        "value": None,
        "states": [],
        "actions": [],
        "bounds": {"x": 0, "y": 0, "width": 1200, "height": 320},
        "children": [control(index) for index in range(start, min(start + 10, CONTROLS))],
    }


def desktop():
    return [{
        "path": [0],
        "role": "application",
        "name": "synthetic-editor",
        "description": "/usr/bin/synthetic-editor",
        "text": None,
        "value": None,
        "states": [],
        "actions": [],
        "bounds": {"x": 0, "y": 0, "width": 1920, "height": 1080},
        "children": [{
            "path": [0, 0],
            "role": "frame",
            "name": "Quick hello — synthetic editor",
            "description": None,
            "text": None,
            "value": None,
            "states": ["active"],
            "actions": [],
            "bounds": {"x": 0, "y": 0, "width": 1920, "height": 1080},
            "children": [panel(start) for start in range(0, CONTROLS, 10)],
        }],
    }]


emit({"ready": True, "ok": True})
for line in sys.stdin:
    line = line.strip()
    if line == "":
        continue
    request_id = None
    try:
        message = json.loads(line)
        if not isinstance(message, dict):
            raise RuntimeError("invalid request")
        request_id = message.get("id")
        if message.get("command") == "quit":
            emit({"id": request_id, "ok": True})
            break
        # The real helper wraps each application root in its own entry, with the
        # walked root in a nodes array and a per-application error slot
        # (daemon/atspi-script.ts snapshot_payload). Emitting the same shape is
        # what lets the daemon's own normalization run unchanged.
        payload = {"applications": [
            {"name": application["name"], "error": None, "nodes": [application]}
            for application in desktop()
        ], "truncated": False}
        payload["id"] = request_id
        payload["ok"] = True
        emit(payload)
    except Exception as error:
        emit({"id": request_id, "ok": False, "error": str(error)})
`

/**
 * A real helper process serving the synthetic desktop, wired through the real
 * persistent-helper protocol.
 *
 * `changed` serves the post-action tree: the same desktop with exactly three
 * edited controls.
 */
export function syntheticHelper(controls: number, changed = false): PersistentHelper {
  return createJsonLineHelper({
    script: SYNTHETIC_DESKTOP_SCRIPT,
    label: "The synthetic desktop helper",
    interpreter: "python3",
    env: { SYNTH_CONTROLS: String(controls), SYNTH_CHANGED: changed ? "1" : "" },
  })
}

const SYNTHETIC_WINDOW_PROPS = `WM_CLASS(STRING) = "synthetic-editor", "Syntheticeditor"
WM_NAME(COMPOUND_TEXT) = "Quick hello — synthetic editor"
_NET_WM_NAME(UTF8_STRING) = "Quick hello — synthetic editor"
_NET_WM_PID(CARDINAL) = 4242
`

const SYNTHETIC_SHELL_PROPS = `WM_CLASS(STRING) = "Shell", "Shell"
WM_NAME(COMPOUND_TEXT) = "synthetic desktop"
_NET_WM_NAME(UTF8_STRING) = "synthetic desktop"
_NET_WM_PID(CARDINAL) = 100
`

const SYNTHETIC_GEOMETRY = (x: number, y: number, width: number, height: number) => `  Absolute upper-left X:  ${x}
  Absolute upper-left Y:  ${y}
  Width: ${width}
  Height: ${height}
`

/**
 * A deterministic two-window X11 list for the synthetic desktop, so a
 * synthetic observation never depends on whatever the operator has open.
 *
 * The real cost of the two live `xprop` root queries is not included here; the
 * test measures it separately on the live display so the two numbers cannot be
 * confused.
 */
export function syntheticWindowRunner(): Runner {
  const windows = [
    { id: "0x1a00011", props: SYNTHETIC_SHELL_PROPS, geometry: SYNTHETIC_GEOMETRY(0, 0, 1920, 1080) },
    { id: "0x7400009", props: SYNTHETIC_WINDOW_PROPS, geometry: SYNTHETIC_GEOMETRY(40, 60, 1200, 800) },
  ]
  return async (file: string, args: readonly string[]): Promise<RunResult> => {
    if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_CLIENT_LIST") {
      return { stdout: `_NET_CLIENT_LIST(WINDOW): window id # ${windows.map((w) => w.id).join(", ")}\n`, stderr: "" }
    }
    if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_ACTIVE_WINDOW") {
      return { stdout: `_NET_ACTIVE_WINDOW(WINDOW): window id # ${windows[1].id}\n`, stderr: "" }
    }
    const byId = windows.find((window) => file === "xprop" && args[1] === window.id)
    if (byId !== undefined) return { stdout: byId.props, stderr: "" }
    const geometry = windows.find((window) => file === "xwininfo" && args[1] === window.id)
    if (geometry !== undefined) return { stdout: geometry.geometry, stderr: "" }
    return { stdout: "", stderr: "" }
  }
}

/** The role/value the semantic-match leg targets, and the act leg sets. */
export const MATCH_ROLE = "textbox"
export const ACTED_VALUE = "typed value 3 (edited)"