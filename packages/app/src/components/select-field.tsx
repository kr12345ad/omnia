import { For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"

export function SelectField(props: {
  label?: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
  class?: string
}) {
  return (
    <label
      class={`flex flex-col items-start gap-2 [font-family:var(--v2-font-family-sans)] ${props.class ?? "w-full"}`}
    >
      <Show when={props.label}>
        <span class="text-[13px] font-[530] text-v2-text-text-muted">{props.label}</span>
      </Show>
      <div class="relative flex h-8 w-full items-center rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 focus-within:border-v2-border-border-base">
        <select
          class="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-[440] text-v2-text-text-base outline-none disabled:cursor-not-allowed"
          value={props.value}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.currentTarget.value)}
        >
          <For each={props.options}>
            {(option) => (
              <option
                value={option.value}
                title={option.label}
                class="bg-v2-background-bg-layer-01 text-v2-text-text-base"
              >
                {option.label}
              </option>
            )}
          </For>
        </select>
        <span class="pointer-events-none absolute right-2 flex size-4 items-center justify-center text-v2-icon-icon-muted">
          <Icon name="chevron-down" size="small" />
        </span>
      </div>
    </label>
  )
}
