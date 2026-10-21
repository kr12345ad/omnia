import { DockTray } from "@opencode-ai/ui/dock-surface"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Dynamic } from "solid-js/web"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"

// Same surface and metrics as the todo dock it sits above: one quiet line that
// names what the draft answers, with the excerpt doing the identifying.
export function SessionReplyDock(props: { text: string; onDismiss: () => void }) {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <Dynamic
      component={settings.general.newLayoutDesigns() ? "div" : DockTray}
      data-component="session-reply-dock"
      classList={{
        "w-full overflow-hidden rounded-xl border-[0.5px] border-v2-border-border-base bg-v2-background-bg-layer-01":
          settings.general.newLayoutDesigns(),
      }}
    >
      <div
        classList={{
          "flex items-center gap-2": true,
          "h-[42px] pl-4 pr-2": settings.general.newLayoutDesigns(),
          "pl-3 pr-2 py-2": !settings.general.newLayoutDesigns(),
        }}
      >
        <span
          classList={{
            "shrink-0 whitespace-nowrap": true,
            "font-[440] text-[13px] leading-5 tracking-[-0.04px] text-v2-text-text-muted":
              settings.general.newLayoutDesigns(),
            "text-14-regular text-text-strong": !settings.general.newLayoutDesigns(),
          }}
        >
          {language.t("ui.message.reply")}
        </span>
        <span
          data-slot="session-reply-preview"
          classList={{
            // The extra margin matches the todo dock's preview offset, so the
            // two cards keep the same label-to-preview rhythm when stacked.
            "ml-1 min-w-0 flex-1 truncate": true,
            "font-[440] text-[13px] leading-5 tracking-[-0.04px] text-v2-text-text-faint":
              settings.general.newLayoutDesigns(),
            "text-14-regular text-text-base": !settings.general.newLayoutDesigns(),
          }}
        >
          {props.text}
        </span>
        <IconButtonV2
          data-action="session-reply-dismiss"
          icon={<Icon name="close" size="small" />}
          size="normal"
          variant="ghost-muted"
          class="shrink-0"
          onClick={props.onDismiss}
          aria-label={language.t("common.close")}
        />
      </div>
    </Dynamic>
  )
}
