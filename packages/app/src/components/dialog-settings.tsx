import { Component, createMemo, createSignal, Show, startTransition } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { SettingsGeneral } from "./settings-general"
import { SettingsAccount } from "./settings-account"
import { SettingsKeybinds } from "./settings-keybinds"
import { SettingsProviders } from "./settings-providers"
import { SettingsModels } from "./settings-models"
import { SettingsServers } from "./settings-servers"
import { SettingsSuperskills } from "./settings-superskills"
import { SettingsMcpMarketplace } from "./settings-mcp-marketplace"
import { SettingsMemory } from "./settings-memory"
import { SettingsComputers } from "./settings-computers"
import { SettingsChatChannels } from "./settings-chat-channels"
import { useEnterprise } from "@/context/enterprise"
import { SettingsComputerUse } from "./settings-computer-use"
import { useLayout } from "@/context/layout"
import { useTabs } from "@/context/tabs"
import { useServerSync } from "@/context/server-sync"

export const DialogSettings: Component<{ defaultValue?: string }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const layout = useLayout()
  const tabs = useTabs()
  const serverSync = useServerSync()
  const [tab, setTab] = createSignal(props.defaultValue ?? "general")
  // A managed client only offers the surfaces its distribution enables.
  const enterprise = useEnterprise()
  const visible = (value: string) => {
    if (value === "chat-channels") return enterprise.feature("chatChannels")
    if (value === "superskills") return enterprise.feature("superskills")
    if (value === "marketplace") return enterprise.feature("mcpMarketplace")
    if (value === "memory") return enterprise.feature("memory")
    if (value === "computer-use" || value === "computers")
      return enterprise.feature("computerUse") && enterprise.permission("computer") !== "deny"
    return true
  }
  const activeTab = () => (visible(tab()) ? tab() : "general")
  const directory = createMemo(() => {
    const route = layout.route()
    if (route.type === "dir-new-sesssion") return route.dir
    if (route.type === "draft") {
      const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
      return draft?.type === "draft" ? draft.directory : undefined
    }
    if (route.type === "session") return serverSync().session.get(route.sessionId)?.directory
    return undefined
  })

  const showProviders = () => {
    void dialog.show(() => <DialogSettings defaultValue="providers" />)
  }

  return (
    <Dialog size="x-large" transition>        <Tabs
          orientation="vertical"
          variant="settings"
          value={activeTab()}
        onChange={(value) => void startTransition(() => setTab(value))}
        class="h-full settings-dialog"
      >
        <Tabs.List>
          <div class="flex flex-col justify-between h-full w-full gap-4">
            <div class="flex flex-col gap-3 w-full pt-3">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="account">
                      <Icon name="shield" />
                      {language.t("desktop.menu.account")}
                    </Tabs.Trigger>
                    <Show when={visible("chat-channels")}>
                      <Tabs.Trigger value="chat-channels">
                        <Icon name="comment" />
                        {language.t("settings.chatChannels.title")}
                      </Tabs.Trigger>
                    </Show>
                    <Tabs.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="servers">
                      <Icon name="server" />
                      {language.t("status.popover.tab.servers")}
                    </Tabs.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.computer")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Show when={visible("superskills")}>
                      <Tabs.Trigger value="superskills">
                        <Icon name="mcp" />
                        {language.t("settings.superskills.title")}
                      </Tabs.Trigger>
                    </Show>
                    <Show when={visible("marketplace")}>
                      <Tabs.Trigger value="marketplace">
                        <Icon name="mcp" />
                        {language.t("settings.mcpMarketplace.title")}
                      </Tabs.Trigger>
                    </Show>
                    <Show when={visible("memory")}>
                      <Tabs.Trigger value="memory">
                        <Icon name="brain" />
                        {language.t("settings.memory.title")}
                      </Tabs.Trigger>
                    </Show>
                    <Show when={visible("computer-use")}>
                      <Tabs.Trigger value="computer-use">
                        <Icon name="glasses" />
                        {language.t("settings.computerUse.title")}
                      </Tabs.Trigger>
                    </Show>
                    <Show when={visible("computers")}>
                      <Tabs.Trigger value="computers">
                        <Icon name="window-cursor" />
                        {language.t("settings.computers.title")}
                      </Tabs.Trigger>
                    </Show>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="providers">
                      <Icon name="providers" />
                      {language.t("settings.providers.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="models">
                      <Icon name="models" />
                      {language.t("settings.models.title")}
                    </Tabs.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
              <span>{language.t("app.name.desktop")}</span>
              <span class="text-11-regular">v{platform.version?.replace(/\.0(?=-|$)/, "")}</span>
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content value="general" class="no-scrollbar">
          <SettingsGeneral />
        </Tabs.Content>
        <Tabs.Content value="account" class="no-scrollbar">
          <SettingsAccount />
        </Tabs.Content>
        <Tabs.Content value="chat-channels" class="no-scrollbar">
          <SettingsChatChannels />
        </Tabs.Content>
        <Tabs.Content value="shortcuts" class="no-scrollbar">
          <SettingsKeybinds />
        </Tabs.Content>
        <Tabs.Content value="servers" class="no-scrollbar">
          <SettingsServers />
        </Tabs.Content>
        <Tabs.Content value="providers" class="no-scrollbar">
          <SettingsProviders onBack={showProviders} />
        </Tabs.Content>
        <Tabs.Content value="models" class="no-scrollbar">
          <SettingsModels />
        </Tabs.Content>
        <Tabs.Content value="superskills" class="no-scrollbar">
          <SettingsSuperskills />
        </Tabs.Content>
        <Tabs.Content value="marketplace" class="no-scrollbar">
          <SettingsMcpMarketplace directory={directory()} />
        </Tabs.Content>
        <Tabs.Content value="memory" class="no-scrollbar">
          <SettingsMemory />
        </Tabs.Content>
        <Tabs.Content value="computer-use" class="no-scrollbar">
          <SettingsComputerUse />
        </Tabs.Content>
        <Tabs.Content value="computers" class="no-scrollbar">
          <SettingsComputers />
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
