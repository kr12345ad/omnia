import { For } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"

const MODES = [
  { id: "work", icon: "window-cursor", labelKey: "mode.work" },
  { id: "code", icon: "code-lines", labelKey: "mode.code" },
] as const

export function ModeToggle() {
  const settings = useSettings()
  const language = useLanguage()
  return (
    <div
      role="tablist"
      aria-label={language.t("mode.ariaLabel")}
      class="flex h-7 shrink-0 items-center gap-0.5 rounded-md bg-surface-raised-base p-0.5"
    >
      <For each={MODES}>
        {(mode) => (
          <button
            type="button"
            role="tab"
            aria-selected={settings.general.mode() === mode.id}
            class="flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-11-medium transition-colors"
            classList={{
              "bg-background-stronger text-text-strong shadow-sm": settings.general.mode() === mode.id,
              "text-text-weak hover:text-text-strong": settings.general.mode() !== mode.id,
            }}
            onClick={() => settings.general.setMode(mode.id)}
          >
            <Icon name={mode.icon} size="small" />
            <span>{language.t(mode.labelKey)}</span>
          </button>
        )}
      </For>
    </div>
  )
}
