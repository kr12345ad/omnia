import { For, Show, type JSX } from "solid-js"
import { decls, num, numbers, strings, text } from "../helpers"
import { HOVER, PANEL, TEXT, TEXT_FAINT, TEXT_MUTED, seriesColor } from "../theme"
import type { OpenUIComponentRenderer } from "../types"

/**
 * Data components: `Table` and the charts.
 *
 * Charts are hand-rolled SVG rather than a charting dependency: they only ever
 * draw a handful of series, and this way every stroke and fill is a theme token
 * so generated UI follows the app's theme by construction. Series take distinct
 * hues from the theme's state palette (see `seriesColor` in `../theme`), never a
 * hardcoded color.
 *
 * `Col` and `Series` are declaration shapes — their parents read them with
 * `decls` — so they render nothing themselves. `Table` is the side-by-side
 * comparison view, the shape a generated answer reaches for when the question is
 * which of several things to pick.
 */

const CHART_WIDTH = 640
const DEFAULT_CHART_HEIGHT = 220
const PAD = { top: 16, right: 12, bottom: 30, left: 48 }

type SeriesShape = { category: string; values: number[] }

function seriesProp(value: unknown, length: number): SeriesShape[] {
  return decls(value).map((entry) => {
    const values = numbers(entry.values)
    return {
      category: text(entry.category) ?? "",
      values: Array.from({ length }, (_, index) => values[index] ?? 0),
    }
  })
}

function heightProp(value: unknown) {
  const height = num(value)
  if (height === undefined) return DEFAULT_CHART_HEIGHT
  return Math.min(520, Math.max(120, Math.round(height)))
}

function allValues(series: SeriesShape[]) {
  return series.flatMap((entry) => entry.values)
}

/** A "nice" step above `raw`, so tick labels are round numbers. */
function niceStep(raw: number) {
  if (!(raw > 0)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

/** Five gridlines spanning the data, always including zero. */
function valueTicks(values: number[]) {
  const low = Math.min(0, ...(values.length ? values : [0]))
  const high = Math.max(0, ...(values.length ? values : [0]))
  if (high === low) return { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] }
  const step = niceStep((high - low) / 4)
  const min = Math.floor(low / step) * step
  const max = Math.ceil(high / step) * step
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => min + index * step)
  return { min, max, ticks }
}

function formatTick(value: number) {
  if (value === 0) return "0"
  const absolute = Math.abs(value)
  if (absolute >= 1000) return `${Math.round(value / 100) / 10}k`
  if (absolute < 1) return String(Math.round(value * 100) / 100)
  return String(Math.round(value * 100) / 100)
}

function Legend(props: { entries: string[] }) {
  return (
    <Show when={props.entries.length > 0}>
      <div data-slot="openui-chart-legend" class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <For each={props.entries}>
          {(entry, index) => (
            <span class={`flex items-center gap-1.5 text-12-regular ${TEXT_MUTED}`}>
              <span class="size-2 shrink-0 rounded-full bg-current" style={seriesColor(index())} />
              <span class="min-w-0 truncate">{entry}</span>
            </span>
          )}
        </For>
      </div>
    </Show>
  )
}

function ChartFrame(props: { name: string; yLabel?: string; xLabel?: string; legend: string[]; children: JSX.Element }) {
  return (
    <div data-component={`openui-${props.name}`} class="my-2 flex flex-col gap-2">
      <Show when={props.yLabel}>
        <div class={`text-12-regular ${TEXT_MUTED}`}>{props.yLabel}</div>
      </Show>
      <div class={`${PANEL} p-3`}>{props.children}</div>
      <Show when={props.xLabel}>
        <div class={`text-center text-12-regular ${TEXT_MUTED}`}>{props.xLabel}</div>
      </Show>
      <Legend entries={props.legend} />
    </div>
  )
}

/** Bar, line and area charts share one cartesian frame: bars sit on a baseline, lines and areas run across bands. */
function CartesianChart(props: {
  name: string
  mode: "bar" | "line" | "area"
  labels: string[]
  series: SeriesShape[]
  variant?: string
  xLabel?: string
  yLabel?: string
  height: number
}): JSX.Element {
  const { min, max, ticks } = valueTicks(allValues(props.series))
  const band = (CHART_WIDTH - PAD.left - PAD.right) / Math.max(props.labels.length, 1)
  const plotHeight = props.height - PAD.top - PAD.bottom
  const y = (value: number) => PAD.top + plotHeight - ((value - min) / (max - min)) * plotHeight
  const baseline = y(0)
  const stacked = props.variant === "stacked"

  const points = (values: number[]) => values.map((value, index) => ({ x: PAD.left + band * (index + 0.5), y: y(value) }))

  const linePath = (values: number[]) => {
    const nodes = points(values)
    if (nodes.length === 0) return ""
    if (props.variant === "step") {
      return nodes
        .map((node, index) => (index === 0 ? `M ${node.x} ${node.y}` : `H ${node.x} V ${node.y}`))
        .join(" ")
    }
    if (props.variant === "natural") return smoothPath(nodes)
    return nodes.map((node, index) => (index === 0 ? `M ${node.x} ${node.y}` : `L ${node.x} ${node.y}`)).join(" ")
  }

  const areaPath = (values: number[]) => {
    const nodes = points(values)
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (!first || !last) return ""
    return `${linePath(values)} L ${last.x} ${baseline} L ${first.x} ${baseline} Z`
  }

  return (
    <ChartFrame
      name={props.name}
      yLabel={props.yLabel}
      xLabel={props.xLabel}
      legend={props.series.map((entry) => entry.category).filter((entry) => entry.length > 0)}
    >
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${props.height}`}
        width="100%"
        height={props.height}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={props.yLabel ?? props.name}
      >
        <For each={ticks}>
          {(tick) => (
            <>
              <line
                x1={PAD.left}
                x2={CHART_WIDTH - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="currentColor"
                stroke-width="1"
                class={TEXT_FAINT}
                opacity={tick === 0 ? 0.45 : 0.18}
              />
              <text
                x={PAD.left - 6}
                y={y(tick) + 4}
                text-anchor="end"
                fill="currentColor"
                class={`text-12-regular ${TEXT_FAINT}`}
              >
                {formatTick(tick)}
              </text>
            </>
          )}
        </For>

        <For each={props.labels}>
          {(label, index) => (
            <text
              x={PAD.left + band * (index() + 0.5)}
              y={props.height - PAD.bottom + 16}
              text-anchor="middle"
              fill="currentColor"
              class={`text-12-regular ${TEXT_FAINT}`}
            >
              {label.length > 12 ? `${label.slice(0, 11)}…` : label}
            </text>
          )}
        </For>

        <Show when={props.mode === "bar"}>
          <For each={props.series}>
            {(entry, seriesIndex) => {
              const group = band * 0.7
              const width = stacked ? group : group / Math.max(props.series.length, 1)
              const running = () => {
                let total = 0
                return entry.values.map((value) => {
                  const base = stacked ? total : 0
                  total += value
                  return { value, base }
                })
              }
              return (
                <For each={running()}>
                  {(cell, index) => {
                    const centre = PAD.left + band * (index() + 0.5)
                    const x = centre - group / 2 + (stacked ? 0 : width * seriesIndex())
                    const top = y(Math.max(cell.value + cell.base, cell.base))
                    const bottom = y(Math.min(cell.value + cell.base, cell.base))
                    return (
                      <rect
                        x={x}
                        y={top}
                        width={Math.max(width, 1)}
                        height={Math.max(bottom - top, 0)}
                        fill="currentColor"
                        style={seriesColor(seriesIndex())}
                      />
                    )
                  }}
                </For>
              )
            }}
          </For>
        </Show>

        <Show when={props.mode === "line" || props.mode === "area"}>
          <For each={props.series}>
            {(entry, seriesIndex) => (
              <Show when={points(entry.values).length > 0}>
                <Show when={props.mode === "area"}>
                  <path d={areaPath(entry.values)} fill="currentColor" style={seriesColor(seriesIndex())} opacity={0.25} />
                </Show>
                <path
                  d={linePath(entry.values)}
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                  style={seriesColor(seriesIndex())}
                />
              </Show>
            )}
          </For>
        </Show>
      </svg>
    </ChartFrame>
  )
}

/** Catmull-Rom control points as cubic beziers; `variant: "natural"`. */
function smoothPath(nodes: { x: number; y: number }[]) {
  if (nodes.length < 3) return nodes.map((node, index) => (index === 0 ? `M ${node.x} ${node.y}` : `L ${node.x} ${node.y}`)).join(" ")
  const controls = nodes.map((node, index) => {
    const previous = nodes[index - 1] ?? node
    const next = nodes[index + 1] ?? node
    return { x: node.x, y: node.y, cx: (next.x - previous.x) / 6, cy: (next.y - previous.y) / 6 }
  })
  return controls
    .map((point, index) => {
      const previous = controls[index - 1]
      if (!previous) return `M ${point.x} ${point.y}`
      return `C ${previous.x + previous.cx} ${previous.y + previous.cy} ${point.x - point.cx} ${point.y - point.cy} ${point.x} ${point.y}`
    })
    .join(" ")
}

function HorizontalBarChart(props: {
  labels: string[]
  series: SeriesShape[]
  variant?: string
  xLabel?: string
  yLabel?: string
}): JSX.Element {
  const { min, max, ticks } = valueTicks(allValues(props.series))
  const stacked = props.variant === "stacked"
  const rowHeight = 28
  const height = Math.max(rowHeight * props.labels.length, 1) + 8
  const labelColumn = 90
  const plotWidth = CHART_WIDTH - labelColumn - PAD.right
  const x = (value: number) => ((value - min) / (max - min)) * plotWidth
  const axisLine = x(0)

  return (
    <ChartFrame
      name="horizontal-bar-chart"
      yLabel={props.yLabel}
      xLabel={props.xLabel}
      legend={props.series.map((entry) => entry.category).filter((entry) => entry.length > 0)}
    >
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={props.yLabel ?? "chart"}
      >
        <For each={ticks}>
          {(tick) => (
            <line
              x1={labelColumn + x(tick)}
              x2={labelColumn + x(tick)}
              y1={0}
              y2={height}
              stroke="currentColor"
              stroke-width="1"
              class={TEXT_FAINT}
              opacity={tick === 0 ? 0.45 : 0.18}
            />
          )}
        </For>
        <For each={props.labels}>
          {(label, index) => (
            <text
              x={labelColumn - 6}
              y={index() * rowHeight + rowHeight / 2 + 4}
              text-anchor="end"
              fill="currentColor"
              class={`text-12-regular ${TEXT_FAINT}`}
            >
              {label.length > 10 ? `${label.slice(0, 9)}…` : label}
            </text>
          )}
        </For>
        <For each={props.series}>
          {(entry, seriesIndex) => {
            const thickness = stacked ? rowHeight * 0.6 : (rowHeight * 0.6) / Math.max(props.series.length, 1)
            const offset = seriesIndex() * thickness - (stacked ? 0 : (rowHeight * 0.6) / 2)
            const running = () => {
              let total = 0
              return entry.values.map((value) => {
                const base = stacked ? total : 0
                total += value
                return { value, base }
              })
            }
            return (
              <For each={running()}>
                {(cell, index) => {
                  const start = x(Math.min(cell.base, cell.base + cell.value)) + labelColumn
                  const end = x(Math.max(cell.base, cell.base + cell.value)) + labelColumn
                  return (
                    <rect
                      x={Math.min(start, end)}
                      y={index() * rowHeight + rowHeight / 2 + offset - thickness / 2}
                      width={Math.max(end - start, 0)}
                      height={Math.max(thickness, 1)}
                      rx="2"
                      fill="currentColor"
                      style={seriesColor(seriesIndex())}
                    />
                  )
                }}
              </For>
            )
          }}
        </For>
        <line x1={labelColumn + axisLine} x2={labelColumn + axisLine} y1={0} y2={height} stroke="currentColor" class={TEXT_FAINT} opacity="0.45" />
      </svg>
    </ChartFrame>
  )
}

function polar(cx: number, cy: number, radius: number, angle: number) {
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
}

function arc(cx: number, cy: number, outer: number, inner: number, start: number, end: number) {
  const large = end - start > Math.PI ? 1 : 0
  const from = polar(cx, cy, outer, start)
  const to = polar(cx, cy, outer, end)
  if (inner <= 0) return `M ${cx} ${cy} L ${from.x} ${from.y} A ${outer} ${outer} 0 ${large} 1 ${to.x} ${to.y} Z`
  const innerFrom = polar(cx, cy, inner, end)
  const innerTo = polar(cx, cy, inner, start)
  return `M ${from.x} ${from.y} A ${outer} ${outer} 0 ${large} 1 ${to.x} ${to.y} L ${innerFrom.x} ${innerFrom.y} A ${inner} ${inner} 0 ${large} 0 ${innerTo.x} ${innerTo.y} Z`
}

function PieChart(props: { labels: string[]; values: number[]; variant?: string; appearance?: string }): JSX.Element {
  const size = 220
  const total = props.values.reduce((sum, value) => sum + Math.max(value, 0), 0)
  const semi = props.appearance === "semiCircular"
  const cx = CHART_WIDTH / 2
  const cy = semi ? size - 20 : size / 2
  const outer = 90
  const inner = props.variant === "donut" ? 52 : 0
  const span = semi ? Math.PI : Math.PI * 2
  const start = semi ? Math.PI : -Math.PI / 2
  const viewHeight = size

  let cursor = start
  const slices = props.values.map((value) => {
    const share = total > 0 ? Math.max(value, 0) / total : 0
    const from = cursor
    const to = cursor + share * span
    cursor = to
    return { from, to }
  })

  return (
    <ChartFrame name="pie-chart" legend={props.labels}>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${viewHeight}`}
        width="100%"
        height={viewHeight}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="chart"
      >
        <Show when={total > 0} fallback={<circle cx={cx} cy={cy} r={outer / 2} fill="none" stroke="currentColor" class={TEXT_FAINT} opacity="0.3" />}>
          <For each={slices}>
            {(slice, index) => (
              <path
                d={arc(cx, cy, outer, inner, slice.from, slice.to)}
                fill="currentColor"
                stroke="currentColor"
                stroke-width="1"
                style={seriesColor(index())}
              />
            )}
          </For>
        </Show>
      </svg>
    </ChartFrame>
  )
}

function SingleStackedBarChart(props: { labels: string[]; values: number[] }): JSX.Element {
  const total = props.values.reduce((sum, value) => sum + Math.max(value, 0), 0)
  const width = CHART_WIDTH - PAD.left - PAD.right
  let cursor = 0
  const segments = props.values.map((value) => {
    const share = total > 0 ? Math.max(value, 0) / total : 0
    const from = cursor
    cursor += share
    return { from, to: cursor }
  })

  return (
    <ChartFrame name="single-stacked-bar-chart" legend={props.labels}>
      <svg viewBox={`0 0 ${CHART_WIDTH} 24`} width="100%" height={24} preserveAspectRatio="xMidYMid meet" role="img" aria-label="chart">
        <Show
          when={total > 0}
          fallback={<rect x={PAD.left} y={6} width={width} height={12} rx="3" fill="currentColor" class={TEXT_FAINT} opacity="0.2" />}
        >
          <For each={segments}>
            {(segment, index) => (
              <rect
                x={PAD.left + segment.from * width}
                y={6}
                width={Math.max((segment.to - segment.from) * width, 0)}
                height={12}
                fill="currentColor"
                style={seriesColor(index())}
              />
            )}
          </For>
        </Show>
      </svg>
    </ChartFrame>
  )
}

/** Table cells arrive as data, not components: primitives render as text, arrays join, anything else stays blank. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    const parts: string[] = value.map((item) => cell(item)).filter((item) => item.length > 0)
    return parts.join(", ")
  }
  return ""
}

function Table(props: { columns: unknown }): JSX.Element {
  const columns = () =>
    decls(props.columns).map((column) => ({
      label: text(column.label) ?? "",
      type: text(column.type),
      values: Array.isArray(column.data) ? column.data : [column.data],
    }))
  const rowCount = () => columns().reduce((count, column) => Math.max(count, column.values.length), 0)

  return (
    <Show when={columns().length > 0}>
      <div data-component="openui-table" class={`my-2 w-full overflow-x-auto ${PANEL}`}>
        <table class="w-full border-collapse text-13-regular">
          <thead>
            <tr>
              <For each={columns()}>
                {(column) => (
                  <th
                    class={`bg-v2-background-bg-layer-02 px-4 py-2.5 text-12-medium ${TEXT_MUTED}`}
                    classList={{ "text-end": column.type === "number", "text-start": column.type !== "number" }}
                  >
                    {column.label}
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={Array.from({ length: rowCount() }, (_, index) => index)}>
              {(row) => (
                <tr class={`border-t border-v2-border-border-muted first:border-t-0 ${HOVER}`}>
                  <For each={columns()}>
                    {(column) => (
                      <td
                        class={`max-w-[320px] px-4 py-2.5 text-13-regular ${TEXT}`}
                        classList={{
                          "text-end tabular-nums": column.type === "number",
                          "text-v2-text-text-accent": column.type === "action",
                        }}
                      >
                        <span class="block truncate">{cell(column.values[row])}</span>
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  )
}

type DataName =
  | "Table"
  | "Col"
  | "BarChart"
  | "LineChart"
  | "AreaChart"
  | "PieChart"
  | "HorizontalBarChart"
  | "SingleStackedBarChart"
  | "Series"

export const dataRenderers: Record<DataName, OpenUIComponentRenderer> = {
  Table: ({ props }) => Table({ columns: props.columns }),
  Col: () => null,
  Series: () => null,
  BarChart: ({ props }) =>
    CartesianChart({
      name: "bar-chart",
      mode: "bar",
      labels: strings(props.labels),
      series: seriesProp(props.series, strings(props.labels).length),
      variant: text(props.variant),
      xLabel: text(props.xLabel),
      yLabel: text(props.yLabel),
      height: heightProp(props.height),
    }),
  LineChart: ({ props }) =>
    CartesianChart({
      name: "line-chart",
      mode: "line",
      labels: strings(props.labels),
      series: seriesProp(props.series, strings(props.labels).length),
      variant: text(props.variant),
      xLabel: text(props.xLabel),
      yLabel: text(props.yLabel),
      height: heightProp(props.height),
    }),
  AreaChart: ({ props }) =>
    CartesianChart({
      name: "area-chart",
      mode: "area",
      labels: strings(props.labels),
      series: seriesProp(props.series, strings(props.labels).length),
      variant: text(props.variant),
      xLabel: text(props.xLabel),
      yLabel: text(props.yLabel),
      height: heightProp(props.height),
    }),
  HorizontalBarChart: ({ props }) =>
    HorizontalBarChart({
      labels: strings(props.labels),
      series: seriesProp(props.series, strings(props.labels).length),
      variant: text(props.variant),
      xLabel: text(props.xLabel),
      yLabel: text(props.yLabel),
    }),
  PieChart: ({ props }) =>
    PieChart({
      labels: strings(props.labels),
      values: numbers(props.values),
      variant: text(props.variant),
      appearance: text(props.appearance),
    }),
  SingleStackedBarChart: ({ props }) =>
    SingleStackedBarChart({ labels: strings(props.labels), values: numbers(props.values) }),
}
