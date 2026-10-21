import { Show, For, createSignal, type JSX, type ParentProps } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/icon"
import type { IconProps } from "@opencode-ai/ui/icon"

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "muted"

export function PageHeader(props: {
  kicker?: string
  title: string
  description?: string
  actions?: JSX.Element
}) {
  return (
    <header class="ent-page-header">
      <div class="ent-page-heading">
        <Show when={props.kicker}>
          <span class="ent-kicker">{props.kicker}</span>
        </Show>
        <h1>{props.title}</h1>
        <Show when={props.description}>
          <p>{props.description}</p>
        </Show>
      </div>
      <Show when={props.actions}>
        <div class="ent-page-actions">{props.actions}</div>
      </Show>
    </header>
  )
}

export function Card(
  props: ParentProps<{
    title?: string
    description?: string
    actions?: JSX.Element
    class?: string
    padded?: boolean
    id?: string
  }>,
) {
  return (
    <section class={`ent-card ${props.class ?? ""}`} id={props.id}>
      <Show when={props.title !== undefined || props.actions !== undefined}>
        <div class="ent-card-head">
          <div>
            <Show when={props.title}>
              <h2>{props.title}</h2>
            </Show>
            <Show when={props.description}>
              <p>{props.description}</p>
            </Show>
          </div>
          <Show when={props.actions}>
            <div class="ent-card-actions">{props.actions}</div>
          </Show>
        </div>
      </Show>
      <div class={props.padded === false ? "ent-card-body ent-card-body-flush" : "ent-card-body"}>{props.children}</div>
    </section>
  )
}

export function Stat(props: {
  label: string
  value: JSX.Element
  hint?: string
  delta?: { value: string; direction: "up" | "down" | "flat"; good?: boolean }
  icon?: IconProps["name"]
  accent?: boolean
}) {
  return (
    <div class="ent-stat" data-accent={props.accent ? "" : undefined}>
      <div class="ent-stat-top">
        <span class="ent-stat-label">{props.label}</span>
        <Show when={props.icon}>
          {(name) => (
            <span class="ent-stat-icon">
              <Icon name={name()} size="small" />
            </span>
          )}
        </Show>
      </div>
      <div class="ent-stat-value">{props.value}</div>
      <div class="ent-stat-foot">
        <Show when={props.delta}>
          {(delta) => (
            <span
              class="ent-delta"
              data-direction={delta().direction}
              data-good={delta().good === undefined ? undefined : String(delta().good)}
            >
              {delta().direction === "up" ? "↑" : delta().direction === "down" ? "↓" : "→"} {delta().value}
            </span>
          )}
        </Show>
        <Show when={props.hint}>
          <span class="ent-stat-hint">{props.hint}</span>
        </Show>
      </div>
    </div>
  )
}

export function Button(
  props: ParentProps<{
    variant?: "primary" | "secondary" | "ghost" | "danger" | "quiet"
    size?: "small" | "normal"
    type?: "button" | "submit"
    icon?: IconProps["name"]
    trailingIcon?: IconProps["name"]
    disabled?: boolean
    loading?: boolean
    onClick?: (event: MouseEvent) => void
    class?: string
    title?: string
  }>,
) {
  return (
    <button
      type={props.type ?? "button"}
      class={`ent-button ${props.class ?? ""}`}
      data-variant={props.variant ?? "secondary"}
      data-size={props.size ?? "normal"}
      disabled={props.disabled || props.loading}
      onClick={(event) => props.onClick?.(event)}
      title={props.title}
    >
      <Show when={props.loading}>
        <span class="ent-spinner" aria-hidden="true" />
      </Show>
      <Show when={!props.loading && props.icon}>
        {(name) => <Icon name={name()} size="small" />}
      </Show>
      <span>{props.children}</span>
      <Show when={props.trailingIcon}>
        {(name) => <Icon name={name()} size="small" />}
      </Show>
    </button>
  )
}

export function IconButton(props: {
  icon: IconProps["name"]
  label: string
  onClick?: (event: MouseEvent) => void
  variant?: "plain" | "danger"
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      class="ent-icon-button"
      data-variant={props.variant ?? "plain"}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={(event) => props.onClick?.(event)}
    >
      <Icon name={props.icon} size="small" />
    </button>
  )
}

export function Field(
  props: ParentProps<{ label: string; hint?: string; error?: string; required?: boolean; class?: string }>,
) {
  return (
    <label class={`ent-field ${props.class ?? ""}`}>
      <span class="ent-field-label">
        {props.label}
        <Show when={props.required}>
          <span class="ent-required">*</span>
        </Show>
      </span>
      {props.children}
      <Show when={props.error}>
        <span class="ent-field-error">{props.error}</span>
      </Show>
      <Show when={props.hint !== undefined && props.error === undefined}>
        <span class="ent-field-hint">{props.hint}</span>
      </Show>
    </label>
  )
}

export function Input(props: {
  value?: string | number
  onInput?: (value: string) => void
  placeholder?: string
  type?: string
  disabled?: boolean
  invalid?: boolean
  name?: string
  autocomplete?: string
  spellcheck?: boolean
  min?: number | string
  max?: number | string
  step?: number | string
  readonly?: boolean
  autofocus?: boolean
  onKeyDown?: (event: KeyboardEvent) => void
}) {
  return (
    <input
      class="ent-input"
      data-invalid={props.invalid ? "" : undefined}
      type={props.type ?? "text"}
      value={props.value ?? ""}
      placeholder={props.placeholder}
      disabled={props.disabled}
      name={props.name}
      autocomplete={props.autocomplete}
      spellcheck={props.spellcheck ?? false}
      min={props.min}
      max={props.max}
      step={props.step}
      readonly={props.readonly}
      autofocus={props.autofocus}
      onInput={(event) => props.onInput?.(event.currentTarget.value)}
      onKeyDown={(event) => props.onKeyDown?.(event)}
    />
  )
}

export function Textarea(props: {
  value?: string
  onInput?: (value: string) => void
  placeholder?: string
  rows?: number
  disabled?: boolean
  spellcheck?: boolean
}) {
  return (
    <textarea
      class="ent-input ent-textarea"
      rows={props.rows ?? 4}
      value={props.value ?? ""}
      placeholder={props.placeholder}
      disabled={props.disabled}
      spellcheck={props.spellcheck ?? true}
      onInput={(event) => props.onInput?.(event.currentTarget.value)}
    />
  )
}

export function Select<T extends string>(props: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string; disabled?: boolean }[]
  disabled?: boolean
}) {
  return (
    <select
      class="ent-input ent-select"
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.currentTarget.value as T)}
    >
      <For each={props.options}>
        {(option) => (
          <option value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        )}
      </For>
    </select>
  )
}

export function Switch(props: {
  checked: boolean
  onChange: (value: boolean) => void
  label?: string
  description?: string
  disabled?: boolean
}) {
  return (
    <label class="ent-switch-row" data-disabled={props.disabled ? "" : undefined}>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        class="ent-switch"
        disabled={props.disabled}
        onClick={() => props.onChange(!props.checked)}
      >
        <span class="ent-switch-thumb" />
      </button>
      <Show when={props.label !== undefined || props.description !== undefined}>
        <span class="ent-switch-text">
          <Show when={props.label}>
            <span class="ent-switch-label">{props.label}</span>
          </Show>
          <Show when={props.description}>
            <span class="ent-switch-description">{props.description}</span>
          </Show>
        </span>
      </Show>
    </label>
  )
}

export function Checkbox(props: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}) {
  return (
    <label class="ent-checkbox-row" data-disabled={props.disabled ? "" : undefined}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span class="ent-checkbox-box" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="11" height="11">
          <path d="M3.5 8.2l3 3.1 6-6.6" fill="none" stroke="currentColor" stroke-width="1.8" />
        </svg>
      </span>
      <span class="ent-checkbox-text">
        <span>{props.label}</span>
        <Show when={props.description}>
          <span class="ent-checkbox-description">{props.description}</span>
        </Show>
      </span>
    </label>
  )
}

export function Tag(props: ParentProps<{ tone?: Tone; dot?: boolean; class?: string }>) {
  return (
    <span class={`ent-tag ${props.class ?? ""}`} data-tone={props.tone ?? "neutral"}>
      <Show when={props.dot}>
        <span class="ent-tag-dot" />
      </Show>
      {props.children}
    </span>
  )
}

export function Avatar(props: { name: string; size?: "small" | "normal"; muted?: boolean }) {
  const initials = () =>
    props.name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  return (
    <span class="ent-avatar" data-size={props.size ?? "normal"} data-muted={props.muted ? "" : undefined}>
      {initials()}
    </span>
  )
}

export function EmptyState(props: {
  icon?: IconProps["name"]
  title: string
  description?: string
  action?: JSX.Element
  compact?: boolean
}) {
  return (
    <div class="ent-empty" data-compact={props.compact ? "" : undefined}>
      <Show when={props.icon}>
        {(name) => (
          <span class="ent-empty-icon">
            <Icon name={name()} />
          </span>
        )}
      </Show>
      <h3>{props.title}</h3>
      <Show when={props.description}>
        <p>{props.description}</p>
      </Show>
      <Show when={props.action}>
        <div class="ent-empty-action">{props.action}</div>
      </Show>
    </div>
  )
}

export function Progress(props: { value: number; max: number; tone?: Tone; label?: string }) {
  const ratio = () => (props.max <= 0 ? 0 : Math.max(0, Math.min(1, props.value / props.max)))
  return (
    <div class="ent-progress" data-tone={props.tone ?? "accent"}>
      <div class="ent-progress-track">
        <div class="ent-progress-fill" style={{ width: `${(ratio() * 100).toFixed(1)}%` }} />
      </div>
      <Show when={props.label}>
        <span class="ent-progress-label">{props.label}</span>
      </Show>
    </div>
  )
}

export function Tabs<T extends string>(props: {
  tabs: { id: T; label: string; count?: number; disabled?: boolean }[]
  active: T
  onChange: (id: T) => void
}) {
  return (
    <div class="ent-tabs" role="tablist">
      <For each={props.tabs}>
        {(tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={props.active === tab.id}
            class="ent-tab"
            data-active={props.active === tab.id ? "" : undefined}
            disabled={tab.disabled}
            onClick={() => props.onChange(tab.id)}
          >
            {tab.label}
            <Show when={tab.count !== undefined}>
              <span class="ent-tab-count">{tab.count}</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  )
}

export function Modal(props: ParentProps<{
  open: boolean
  onClose: () => void
  title: string
  description?: string
  footer?: JSX.Element
  width?: "normal" | "wide"
  side?: boolean
}>) {
  return (
    <Show when={props.open}>
      <Portal>
        <div class="ent-modal-scrim" onClick={() => props.onClose()}>
          <div
            class="ent-modal"
            data-width={props.width ?? "normal"}
            data-side={props.side ? "" : undefined}
            role="dialog"
            aria-modal="true"
            aria-label={props.title}
            onClick={(event) => event.stopPropagation()}
          >
            <div class="ent-modal-head">
              <div>
                <h2>{props.title}</h2>
                <Show when={props.description}>
                  <p>{props.description}</p>
                </Show>
              </div>
              <IconButton icon="close" label="Close" onClick={() => props.onClose()} />
            </div>
            <div class="ent-modal-body">{props.children}</div>
            <Show when={props.footer}>
              <div class="ent-modal-foot">{props.footer}</div>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  )
}

export function CopyField(props: { value: string; label?: string }) {
  const [copied, setCopied] = createSignal(false)
  const copy = async () => {
    await navigator.clipboard.writeText(props.value).catch(() => undefined)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_600)
  }
  return (
    <div class="ent-copy-field">
      <code>{props.value}</code>
      <Button size="small" variant="ghost" icon={copied() ? "check" : "copy"} onClick={() => void copy()}>
        {copied() ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}

export function Skeleton(props: { height?: number; width?: string }) {
  return <div class="ent-skeleton" style={{ height: `${props.height ?? 16}px`, width: props.width ?? "100%" }} />
}

export function SectionDivider(props: { label: string }) {
  return (
    <div class="ent-section-divider">
      <span>{props.label}</span>
    </div>
  )
}

export function InlineNote(props: ParentProps<{ tone?: Tone; icon?: IconProps["name"] }>) {
  return (
    <div class="ent-note" data-tone={props.tone ?? "neutral"}>
      <Show when={props.icon}>
        {(name) => <Icon name={name()} size="small" />}
      </Show>
      <div>{props.children}</div>
    </div>
  )
}

export function Definition(props: ParentProps<{ label: string }>) {
  return (
    <div class="ent-definition">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  )
}
