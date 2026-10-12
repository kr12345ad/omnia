// Per-step latency budget for the computer-use step path, measured.
//
// specs/v27/latency-harness.md:66-81 carries a ~29s/step CPU heuristic for
// vision inference and no first-token number, which cannot size a multi-step
// task. This file measures the other half of a step — the half that runs without
// a model — against synthetic desktops of 50/200/500/1000 controls, and states
// the largest desktop that fits a 2s step budget on this host.
//
// The numbers are real measurements, not estimates:
//   * the synthetic desktop is served by a real python3 helper over the real
//     JSON-line protocol (`daemon/persistent-helper.ts`), so spawn, pipe
//     transfer, and decode are all inside the measurement;
//   * the accessibility capture, the semantic match, the ref resolution, the aim
//     selection, the act, and the verify all run the shipped code paths;
//   * the live display is measured separately through the unmodified AT-SPI
//     script, so "our code" and "the capture" are reported apart.
//
// Run: cd packages/omnia && bun test src/computer-use/latency-budget.test.ts

import { afterAll, describe, expect, test } from "bun:test"
import { diffObservations, fromProtocolObservation, type SemanticObservation } from "../environment/index"
import { retrieveElements } from "../retrieval/retrieval"
import { executeAction, resolveAction } from "../actions/resolve"
import { verifyActionResult } from "../actions/verification"
import { LinuxHostDriver } from "../daemon/linux"
import type { Observation, UIElement } from "../protocol"
import { computeAim } from "./aim"
import {
  ACTED_VALUE,
  CHANGED_CONTROLS,
  DESKTOP_SIZES,
  invalidateSnapshot,
  MATCH_QUERY,
  MATCH_ROLE,
  MEASURED_RUNS,
  measure,
  round,
  STEP_BUDGET_MS,
  syntheticHelper,
  syntheticWindowRunner,
  type DesktopSize,
  type Timing,
} from "./latency-budget"

// Sizes beyond the reported table, measured to find where the 2s step budget
// actually breaks instead of extrapolating to an answer.
const LARGE_SIZES = [2000, 5000, 10000] as const

const SYNTHETIC_TARGET = { kind: "application" as const, id: "synthetic-editor", title: "Quick hello — synthetic editor" }

// The ref of "Control 3": panel 0, fourth control, under the editor frame.
const TARGET_REF = "atspi:0.0.0.3"

const LIVE_DISPLAY = process.env.DISPLAY
const LIVE_HARNESS_ARMED = process.env.OMNIA_LIVE_HARNESS === "1"

interface Row {
  readonly size: number
  readonly elements: number
  readonly snapshotMs: number
  readonly payloadChars: number
  readonly matchMs: number
  readonly actMs: number
  readonly verifyMs: number
  readonly stepMs: number
  readonly maxMs: number
}

// A real act injects input: two XTest round trips per click (the click, then the
// read-back of where the pointer landed, daemon/linux.ts:1575-1578). The act leg
// above is the shipped orchestration only, so the step total a real host pays
// adds the measured round trip back in. Without a live display measurement this
// is the same number, which is why the column says so instead of guessing.
function withRealInput(row: Row): number {
  return row.stepMs + inputRoundTripMs * INPUT_ROUND_TRIPS_PER_CLICK
}

const rows: Row[] = []
const large: Row[] = []

// The input channel, measured once on the live display. A click performs two
// XTest round trips (the click, then the read-back of where the pointer landed,
// daemon/linux.ts:1575-1578), so the orchestration-only act leg understates a
// real act by twice this.
const INPUT_ROUND_TRIPS_PER_CLICK = 2
let inputRoundTripMs = 0

// Every driver owns a real helper process. One registry so the torn-down set
// covers the drivers each describe block creates too.
const drivers: LinuxHostDriver[] = []
const helpers: Array<{ dispose(): Promise<void> }> = []

afterAll(async () => {
  for (const driver of drivers) driver.dispose()
  await Promise.all(helpers.map((helper) => helper.dispose()))
})

function desktop(controls: number, changed: boolean): LinuxHostDriver {
  const helper = syntheticHelper(controls, changed)
  helpers.push(helper)
  const driver = new LinuxHostDriver({
    runner: syntheticWindowRunner(),
    display: ":99",
    session: "x11",
    probeDisplay: false,
    atspiHelper: helper,
  })
  drivers.push(driver)
  return driver
}

function semantic(observation: Observation, index: number): SemanticObservation {
  return fromProtocolObservation({
    observation,
    target: SYNTHETIC_TARGET,
    id: `semantic-${index}`,
    capturedAt: `2026-10-11T10:00:0${index}.000Z`,
  })
}

function controls(observation: Observation): readonly UIElement[] {
  return (observation.elements ?? []).filter((element) => element.role !== "window" && element.role !== "application")
}

function aimable(observation: Observation): readonly UIElement[] {
  return (observation.elements ?? []).filter((element) => (element.actions ?? []).length > 0 && element.bounds !== undefined)
}

function valueOf(observation: Observation, elementId: string): string | undefined {
  const element = (observation.elements ?? []).find((candidate) => candidate.id === elementId)
  return typeof element?.value === "string" ? element.value : undefined
}

function summarize(samples: readonly number[]): Timing {
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    meanMs: samples.reduce((total, sample) => total + sample, 0) / Math.max(1, samples.length),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    runs: samples.length,
  }
}

function table(all: readonly Row[]): string {
  const header =
    "| desktop (controls) | elements | snapshot p50 | payload | match p50 | act p50 | verify p50 | **deterministic step** | + real input | 2s budget |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  const body = all.map((row) => {
    const realistic = withRealInput(row)
    return (
      `| ${row.size} | ${row.elements} | ${round(row.snapshotMs)}ms | ${row.payloadChars} | ${round(row.matchMs)}ms | ` +
      `${round(row.actMs)}ms | ${round(row.verifyMs)}ms | **${round(row.stepMs)}ms** | ${round(realistic)}ms | ` +
      `${realistic <= STEP_BUDGET_MS ? "inside" : "BLOWN"} |`
    )
  })
  return [header, ...body].join("\n")
}

// The live-display measurement needs a real X server. Anything else reports a
// skip rather than failing against a display that is not there, matching the
// convention the live harness uses.
const LIVE_SKIP_REASON = (() => {
  if (!LIVE_HARNESS_ARMED) return "set OMNIA_LIVE_HARNESS=1 to run the real-display measurement"
  if (process.platform !== "linux") return `needs a Linux/X11 host; this host is ${process.platform}`
  if (LIVE_DISPLAY === undefined || LIVE_DISPLAY.trim().length === 0) return "DISPLAY is unset or empty"
  return undefined
})()

describe("computer-use step latency budget", () => {
  test.skipIf(LIVE_SKIP_REASON !== undefined)(
    `the live accessibility capture and the input channel are measured first (${LIVE_SKIP_REASON ?? "display present"})`,
    async () => {
      // The real AT-SPI helper, real python3/pyatspi, real DBus, real xprop, real
      // display. This is the number that decides whether the capture, rather than
      // our code, owns the step budget.
      const live = new LinuxHostDriver({ display: LIVE_DISPLAY, session: "x11" })
      drivers.push(live)
      // The driver replays a capture for 350ms (daemon/linux.ts:OBSERVATION_TTL_MS),
      // so each measured run has to drop it or the capture leg measures a cache
      // hit and reports 0ms.
      const capture = await measure(() => {
        invalidateSnapshot(live)
        return live.observe()
      })
      const observation = await live.observe()
      const windowList = await measure(() => live.windows())
      const find = await measure(() => live.find({ query: MATCH_QUERY }))
      // `pointerPosition()` is the second of the two XTest round trips a click
      // performs, so it measures the input channel without moving the
      // operator's pointer.
      const input = await measure(() => live.pointerPosition())
      inputRoundTripMs = input.medianMs
      console.log(
        `live display: observe p50=${round(capture.medianMs)}ms (n=${capture.runs}, max ${round(capture.maxMs)}ms) ` +
          `elements=${(observation.elements ?? []).length} payload=${JSON.stringify(observation).length} chars\n` +
          `live display: X11 window list p50=${round(windowList.medianMs)}ms, semantic find p50=${round(find.medianMs)}ms, ` +
          `XTest input round trip p50=${round(input.medianMs)}ms (a click performs two: daemon/linux.ts:1575-1578)`,
      )
      // A capture that returned nothing would make every number below vacuous.
      expect((observation.elements ?? []).length).toBeGreaterThan(0)
      expect(capture.medianMs).toBeLessThan(STEP_BUDGET_MS / 10)
      expect(input.medianMs).toBeLessThan(STEP_BUDGET_MS / 10)
    },
    15_000,
  )

  for (const size of DESKTOP_SIZES) {
    describe(`${size} controls`, () => {
      test("measures snapshot, ref resolution, aim, and semantic match", async () => {
        const driver = desktop(size, false)
        driver.invalidateObservation()
        const observation = await driver.observe()
        const payload = JSON.stringify(observation)
        const elements = controls(observation)
        const actionable = aimable(observation)

        // 1. Full snapshot.
        const snapshot = await measure(() => {
          invalidateSnapshot(driver)
          return driver.observe()
        })

        // 3. Ref resolution inside an observation, by the ref the snapshot minted.
        const reference =
          elements.find((element) => element.id === TARGET_REF)?.id ?? elements[0]?.id ?? TARGET_REF
        const refResolve = await measure(() =>
          resolveAction(
            { type: "setvalue", target: { kind: "element", elementId: reference }, value: ACTED_VALUE },
            { observation },
          ),
        )

        // 4. Aim computation over every actionable element in the observation.
        const aim = await measure(() =>
          actionable.map((element) => computeAim({ bounds: element.bounds!, role: element.role })),
        )

        // 5. Semantic match: the query is scored against every element.
        const match = await measure(() => retrieveElements(observation, { query: MATCH_QUERY, role: MATCH_ROLE }))

        console.log(
          `${size} controls (${(observation.elements ?? []).length} elements):\n` +
            `  1. snapshot         p50=${round(snapshot.medianMs)}ms max=${round(snapshot.maxMs)}ms payload=${payload.length} chars\n` +
            `  2. diff             measured in the diff test below\n` +
            `  3. ref resolution   p50=${round(refResolve.medianMs)}ms max=${round(refResolve.maxMs)}ms\n` +
            `  4. aim x${actionable.length}          p50=${round(aim.medianMs)}ms max=${round(aim.maxMs)}ms\n` +
            `  5. semantic match   p50=${round(match.medianMs)}ms max=${round(match.maxMs)}ms`,
        )

        // A full snapshot must really be full: one element per control, plus the
        // panels, the frame, the application root, and the X11 windows.
        expect(elements.length).toBeGreaterThanOrEqual(size)
        expect((observation.elements ?? []).length).toBeGreaterThan(elements.length)
        expect(actionable.length).toBeGreaterThan(0)
        // Every measured run must have been a fresh capture, not a replay of the
        // driver's 350ms observation cache.
        invalidateSnapshot(driver)
        const first = await driver.observe()
        invalidateSnapshot(driver)
        const second = await driver.observe()
        expect(second.id).not.toBe(first.id)
      })
    })
  }

  describe("diff snapshot", () => {
    test("costs the changed controls, not the desktop", async () => {
      for (const size of DESKTOP_SIZES) {
        const baseline = desktop(size, false)
        const current = desktop(size, true)
        baseline.invalidateObservation()
        current.invalidateObservation()
        const before = await baseline.observe()
        const after = await current.observe()
        const previous = semantic(before, 1)
        const next = semantic(after, 2)
        const fullChars = JSON.stringify(before).length
        const project = () => diffObservations(previous, next).changed.map((change) => ({ id: change.after.id, fields: change.fields }))
        const diffChars = JSON.stringify(project()).length
        const diff = await measure(() => diffObservations(previous, next))
        const result = diffObservations(previous, next)

        console.log(
          `diff at ${size} controls: full=${fullChars} chars, diff=${diffChars} chars ` +
            `(${Math.round(fullChars / diffChars)}x smaller) ` +
            `diff p50=${round(diff.medianMs)}ms (max ${round(diff.maxMs)}ms) ` +
            `changed=${result.changed.length} moved=${result.moved.length} unchanged=${result.unchanged}`,
        )

        // Three edited controls and nothing else moved: a diff that reports more
        // is diffing something that did not change, and a diff that is not
        // smaller did not pay for itself.
        expect(result.changed.length + result.moved.length).toBe(CHANGED_CONTROLS)
        expect(result.unchanged).toBe((before.elements ?? []).length - CHANGED_CONTROLS)
        expect(diffChars).toBeLessThan(fullChars)
        expect(diff.medianMs).toBeLessThan(STEP_BUDGET_MS / 10)
      }
    })
  })

  describe("a typical step", () => {
    // One measured step: snapshot, match, act, verify. Returns false when any leg
    // fails, so a broken step never enters the table.
    const runStep = async (size: number): Promise<Row | undefined> => {
      const before = desktop(size, false)
      const after = desktop(size, true)
      const samples: Record<"snapshot" | "match" | "act" | "verify", number[]> = {
        snapshot: [],
        match: [],
        act: [],
        verify: [],
      }
      let payloadChars = 0
      let elementCount = 0

      const step = async (): Promise<boolean> => {
      // (a) snapshot
      invalidateSnapshot(before)
        const snapshotStarted = performance.now()
        const observation = await before.observe()
        samples.snapshot.push(performance.now() - snapshotStarted)
        payloadChars = JSON.stringify(observation).length
        elementCount = (observation.elements ?? []).length

        // (b) semantic match
        const matchStarted = performance.now()
        const retrieval = retrieveElements(observation, { query: MATCH_QUERY, role: MATCH_ROLE })
        samples.match.push(performance.now() - matchStarted)
        const selected = retrieval.matches.find((entry) => entry.element.id === TARGET_REF) ?? retrieval.matches[0]
        if (selected === undefined) return false

        // (c) act: the shipped resolve/execute path. A real host injects input
        // here; the test applies the edit to the synthetic desktop instead.
        const actStarted = performance.now()
        const executed = await executeAction(
          { type: "setvalue", target: { kind: "element", elementId: selected.element.id! }, value: ACTED_VALUE },
          {
            observation,
            verify: false,
            execute: () => ({ success: true, status: "success", message: "The value was set." }),
          },
        )
        samples.act.push(performance.now() - actStarted)
        if (!executed.success) return false

        // (d) verify against a fresh post-action observation: the act only counts
        // as verified when the new tree carries the edit.
        const verifyStarted = performance.now()
        invalidateSnapshot(after)
        const postAction = await after.observe()
        const verification = verifyActionResult(executed.result, {
          kind: "value",
          expected: ACTED_VALUE,
          actual: valueOf(postAction, selected.element.id!),
        })
        samples.verify.push(performance.now() - verifyStarted)
        return verification.verified === true
      }

      for (let warmup = 0; warmup < 3; warmup += 1) if (!(await step())) return undefined
      for (const key of ["snapshot", "match", "act", "verify"] as const) samples[key].length = 0
      for (let run = 0; run < MEASURED_RUNS; run += 1) if (!(await step())) return undefined

      const legs = {
        snapshot: summarize(samples.snapshot),
        match: summarize(samples.match),
        act: summarize(samples.act),
        verify: summarize(samples.verify),
      }
      const stepMs = legs.snapshot.medianMs + legs.match.medianMs + legs.act.medianMs + legs.verify.medianMs
      return {
        size,
        elements: elementCount,
        snapshotMs: legs.snapshot.medianMs,
        payloadChars,
        matchMs: legs.match.medianMs,
        actMs: legs.act.medianMs,
        verifyMs: legs.verify.medianMs,
        stepMs,
        maxMs: legs.snapshot.maxMs + legs.match.maxMs + legs.act.maxMs + legs.verify.maxMs,
      }
    }

    test("reports snapshot + match + act + verify at every size", async () => {
      for (const size of DESKTOP_SIZES as readonly DesktopSize[]) {
        const row = await runStep(size)
        expect(row).toBeDefined()
        rows.push(row!)
        console.log(
          `typical step at ${size} controls: snapshot=${round(row!.snapshotMs)}ms (max ${round(row!.maxMs)}ms) ` +
            `+ match=${round(row!.matchMs)}ms + act=${round(row!.actMs)}ms + verify=${round(row!.verifyMs)}ms ` +
            `= ${round(row!.stepMs)}ms (${row!.stepMs <= STEP_BUDGET_MS ? "inside" : "BLOWN"} the ${STEP_BUDGET_MS}ms budget)`,
        )
      }
      console.log(`\n${table(rows)}\n`)
    })

    test(
      "finds where the 2s step budget actually breaks",
      async () => {
        for (const size of LARGE_SIZES) {
          const row = await runStep(size)
          if (row === undefined) continue
          large.push(row)
          console.log(
            `typical step at ${size} controls: snapshot=${round(row.snapshotMs)}ms + match=${round(row.matchMs)}ms ` +
              `+ act=${round(row.actMs)}ms + verify=${round(row.verifyMs)}ms = ${round(row.stepMs)}ms ` +
              `payload=${row.payloadChars} chars`,
          )
        }
        const all = [...rows, ...large]
        console.log(`\n${table(all)}\n`)
        // The budget is asked for on this host with a real step; the only honest
        // answer is the largest desktop that was actually run and still fit.
        const fitting = all.filter((row) => withRealInput(row) <= STEP_BUDGET_MS)
        const largest = fitting.at(-1)
        expect(largest).toBeDefined()
        expect(large.at(-1)!.size).toBeGreaterThan(rows.at(-1)!.size)
        // The step is linear in desktop size, so the boundary is a straight line
        // fit through the two largest measured points, not a guess.
        const head = all[all.length - 1]
        const tail = all[all.length - 2]
        const perControl = (head.stepMs - tail.stepMs) / (head.size - tail.size)
        const boundary = STEP_BUDGET_MS / Math.max(perControl, 1e-9)
        console.log(
          `largest measured desktop inside the ${STEP_BUDGET_MS}ms step budget: ${largest!.size} controls ` +
            `(${round(withRealInput(largest!))}ms with real input injection); ` +
            `extrapolating the measured ${round(perControl, 4)}ms/control, the boundary is around ${Math.round(boundary)} controls`,
        )
      },
      // A 10 000-control desktop measures real captures of a ~7 MB payload
      // eighteen times each; the default 5s test budget is smaller than one
      // measured scenario.
      120_000,
    )
  })

  test("no measured leg owns the step budget on its own", () => {
    for (const row of [...rows, ...large]) {
      // The step total must fit, and no single leg may be the reason it does not:
      // a step that fits only because the slowest leg was omitted is not a
      // measured step.
      expect(row.stepMs).toBeLessThanOrEqual(STEP_BUDGET_MS)
      expect(Math.max(row.snapshotMs, row.matchMs, row.actMs, row.verifyMs)).toBeLessThanOrEqual(STEP_BUDGET_MS)
      expect(row.payloadChars).toBeGreaterThan(0)
    }
    expect(rows.length).toBe(DESKTOP_SIZES.length)
  })
})
