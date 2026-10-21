import { For, Show, createMemo, createUniqueId } from "solid-js"

export interface Point {
  key: string
  value: number
  secondary?: number
  label?: string
}

const WIDTH = 640

function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

export function AreaChart(props: {
  data: Point[]
  height?: number
  format?: (value: number) => string
  label?: string
  color?: string
  showAxis?: boolean
}) {
  const height = () => props.height ?? 200
  const format = () => props.format ?? ((value: number) => String(Math.round(value)))
  const fill = createUniqueId()
  const max = createMemo(() => niceMax(Math.max(...props.data.map((point) => point.value), 0)))
  const empty = createMemo(() => props.data.length === 0 || props.data.every((point) => point.value === 0))
  const points = createMemo(() => {
    const list = props.data
    if (list.length === 0) return []
    // Keep the first and last labels inside the plot. Centring a date tick on
    // the viewBox edge clips it, which is what made the overview axis look cut.
    const inset = props.showAxis === false ? 4 : 26
    const innerWidth = WIDTH - inset * 2
    const innerHeight = height() - (props.showAxis === false ? 8 : 14)
    return list.map((point, index) => ({
      ...point,
      x: inset + (list.length === 1 ? innerWidth / 2 : (index / (list.length - 1)) * innerWidth),
      y: 8 + innerHeight - (point.value / max()) * innerHeight,
    }))
  })
  const line = createMemo(() => points().map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "))
  const area = createMemo(() => {
    const list = points()
    if (list.length === 0) return ""
    const bottom = height() - (props.showAxis === false ? 8 : 14) + 8
    return `${line()} L${list[list.length - 1]!.x.toFixed(1)},${bottom} L${list[0]!.x.toFixed(1)},${bottom} Z`
  })
  const grid = createMemo(() => [0.25, 0.5, 0.75].map((fraction) => 8 + (height() - (props.showAxis === false ? 8 : 14)) * fraction))
  const ticks = createMemo(() => {
    const list = points()
    if (list.length < 2) return list
    return [list[0]!, list[Math.floor((list.length - 1) / 2)]!, list[list.length - 1]!]
  })

  return (
    <div class="ent-chart" data-height={height()}>
      <svg viewBox={`0 0 ${WIDTH} ${height()}`} preserveAspectRatio="none" role="img" aria-label={props.label ?? "Chart"}>
        <defs>
          <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color={props.color ?? "var(--ent-accent)"} stop-opacity="0.18" />
            <stop offset="100%" stop-color={props.color ?? "var(--ent-accent)"} stop-opacity="0" />
          </linearGradient>
        </defs>
        <For each={grid()}>
          {(y) => <line x1="0" x2={WIDTH} y1={y} y2={y} stroke="var(--ent-border)" stroke-dasharray="2 4" vector-effect="non-scaling-stroke" />}
        </For>
        <Show when={points().length > 1 && !empty()}>
          <path d={area()} fill={`url(#${fill})`} />
          <path
            d={line()}
            fill="none"
            stroke={props.color ?? "var(--ent-accent)"}
            stroke-width="1.75"
            stroke-linejoin="round"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        </Show>
        <For each={points()}>
          {(point, index) => (
            <g>
              <circle cx={point.x} cy={point.y} r="6" fill="transparent">
                <title>{`${point.label ?? point.key}: ${format()(point.value)}`}</title>
              </circle>
              <Show when={index() === points().length - 1 && !empty()}>
                <circle cx={point.x} cy={point.y} r="2.5" fill={props.color ?? "var(--ent-accent)"} />
              </Show>
            </g>
          )}
        </For>
      </svg>
      <Show when={props.showAxis !== false}>
        <div class="ent-chart-axis" aria-hidden="true">
          <For each={ticks()}>
            {(point) => <span>{point.label ?? point.key}</span>}
          </For>
        </div>
        <div class="ent-chart-max">{format()(max())}</div>
      </Show>
      <Show when={empty()}>
        <div class="ent-chart-empty">No activity in this window</div>
      </Show>
    </div>
  )
}

export function BarChart(props: {
  data: Point[]
  height?: number
  format?: (value: number) => string
  horizontal?: boolean
  color?: string
}) {
  const height = () => props.height ?? 200
  const format = () => props.format ?? ((value: number) => String(Math.round(value)))
  const max = createMemo(() => niceMax(Math.max(...props.data.map((point) => point.value), 0)))

  if (props.horizontal === false) {
    return (
      <div class="ent-bars" style={{ height: `${height()}px` }}>
        <For each={props.data}>
          {(point) => (
            <div class="ent-bar-column" title={`${point.label ?? point.key}: ${format()(point.value)}`}>
              <div class="ent-bar-value">{format()(point.value)}</div>
              <div class="ent-bar-track">
                <div
                  class="ent-bar-fill"
                  style={{
                    height: `${Math.max(2, (point.value / max()) * 100)}%`,
                    background: props.color ?? "var(--ent-accent)",
                  }}
                />
              </div>
              <div class="ent-bar-label">{point.label ?? point.key}</div>
            </div>
          )}
        </For>
      </div>
    )
  }

  return (
    <div class="ent-bars-horizontal">
      <For each={props.data}>
        {(point) => (
          <div class="ent-bar-row" title={`${point.label ?? point.key}: ${format()(point.value)}`}>
            <span class="ent-bar-row-label">{point.label ?? point.key}</span>
            <span class="ent-bar-row-track">
              <span
                class="ent-bar-row-fill"
                style={{
                  width: `${Math.max(1, (point.value / max()) * 100)}%`,
                  background: props.color ?? "var(--ent-accent)",
                }}
              />
            </span>
            <span class="ent-bar-row-value">{format()(point.value)}</span>
          </div>
        )}
      </For>
    </div>
  )
}

export function Donut(props: {
  slices: { label: string; value: number; color?: string }[]
  size?: number
  center?: { label: string; value: string }
}) {
  const size = () => props.size ?? 164
  const radius = () => size() / 2 - 12
  const circumference = () => 2 * Math.PI * radius()
  const total = createMemo(() => props.slices.reduce((sum, slice) => sum + slice.value, 0))
  const rendered = createMemo(() => {
    let offset = 0
    return props.slices.map((slice, index) => {
      const fraction = total() <= 0 ? 0 : slice.value / total()
      const dash = fraction * circumference()
      const item = {
        ...slice,
        color: slice.color ?? PALETTE[index % PALETTE.length]!,
        dash,
        offset,
      }
      offset += dash
      return item
    })
  })
  return (
    <div class="ent-donut" style={{ "--ent-donut-size": `${size()}px` }}>
      <svg viewBox={`0 0 ${size()} ${size()}`} role="img" aria-label="Distribution">
        <circle cx={size() / 2} cy={size() / 2} r={radius()} fill="none" stroke="var(--ent-border)" stroke-width="10" />
        <For each={rendered()}>
          {(slice) => (
            <circle
              cx={size() / 2}
              cy={size() / 2}
              r={radius()}
              fill="none"
              stroke={slice.color}
              stroke-width="10"
              stroke-dasharray={`${slice.dash} ${circumference() - slice.dash}`}
              stroke-dashoffset={-slice.offset}
              transform={`rotate(-90 ${size() / 2} ${size() / 2})`}
              stroke-linecap="butt"
            >
              <title>{`${slice.label}: ${slice.value}`}</title>
            </circle>
          )}
        </For>
      </svg>
      <Show when={props.center}>
        <div class="ent-donut-center">
          <span>{props.center!.label}</span>
          <strong>{props.center!.value}</strong>
        </div>
      </Show>
      <div class="ent-donut-legend">
        <For each={rendered()}>
          {(slice) => (
            <div class="ent-donut-legend-row">
              <span class="ent-legend-swatch" style={{ background: slice.color }} />
              <span class="ent-donut-legend-label">{slice.label}</span>
              <span class="ent-donut-legend-value">{slice.value}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

export function Sparkline(props: { values: number[]; width?: number; height?: number; color?: string }) {
  const width = () => props.width ?? 96
  const height = () => props.height ?? 28
  const path = createMemo(() => {
    if (props.values.length === 0) return ""
    const max = Math.max(...props.values, 1)
    const min = Math.min(...props.values, 0)
    const range = max - min || 1
    return props.values
      .map((value, index) => {
        const x = (index / Math.max(1, props.values.length - 1)) * (width() - 2) + 1
        const y = height() - 2 - ((value - min) / range) * (height() - 4)
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(" ")
  })
  return (
    <svg class="ent-sparkline" viewBox={`0 0 ${width()} ${height()}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={path()} fill="none" stroke={props.color ?? "var(--ent-accent)"} stroke-width="1.5" vector-effect="non-scaling-stroke" />
    </svg>
  )
}

export const PALETTE = ["#2563eb", "#0d9488", "#7c3aed", "#d97706", "#dc2626", "#0891b2", "#65a30d", "#9333ea"]
