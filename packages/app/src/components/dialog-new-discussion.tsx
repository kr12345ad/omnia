import { Show, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { SelectField } from "./select-field"

export function DialogNewDiscussion() {
  const language = useLanguage()
  const tabs = useTabs()
  const server = useServer()
  const layout = useLayout()
  const dialog = useDialog()
  const [store, setStore] = createStore({
    topic: "",
    goal: "",
    rounds: 2,
    error: "",
  })
  const [starting, setStarting] = createSignal(false)

  const start = () => {
    const topic = store.topic.trim()
    if (topic.length === 0) {
      setStore("error", language.t("work.home.discussion.topicRequired"))
      return
    }
    const directory = layout.projects.list()[0]?.worktree
    if (directory === undefined) {
      setStore("error", language.t("work.home.discussion.noProject"))
      return
    }
    setStarting(true)
    void tabs
      .newDraft(
        { server: server.key, directory, mode: "work" },
        language.t("work.home.discussion.prompt", {
          topic,
          goal: store.goal.trim().length === 0 ? language.t("work.home.discussion.defaultGoal") : store.goal.trim(),
          rounds: String(store.rounds),
        }),
      )
      .then(() => dialog.close())
      .catch((error: unknown) => {
        setStore("error", error instanceof Error ? error.message : String(error))
        setStarting(false)
      })
  }

  return (
    <Dialog
      title={language.t("work.home.discussion.title")}
      description={language.t("work.home.discussion.subtitle")}
      fit
      class="[font-family:var(--v2-font-family-sans)]"
    >
      <div class="flex w-[520px] max-w-full flex-col gap-4 pl-6 pr-2.5 pb-3">
        <TextField
          label={language.t("work.home.discussion.topic")}
          placeholder={language.t("work.home.discussion.topicPlaceholder")}
          value={store.topic}
          onChange={(value) => setStore("topic", value)}
        />
        <TextField
          label={language.t("work.home.discussion.goal")}
          placeholder={language.t("work.home.discussion.goalPlaceholder")}
          value={store.goal}
          onChange={(value) => setStore("goal", value)}
        />
        <SelectField
          label={language.t("work.home.discussion.rounds")}
          value={String(store.rounds)}
          options={[
            { value: "1", label: language.t("work.home.discussion.rounds.one") },
            { value: "2", label: language.t("work.home.discussion.rounds.two") },
            { value: "3", label: language.t("work.home.discussion.rounds.three") },
          ]}
          onChange={(value) => setStore("rounds", Number(value) || 2)}
        />
        <div class="text-[11px] font-[440] text-v2-text-text-muted">{language.t("work.home.discussion.agents")}</div>

        <Show when={store.error}>
          <div class="rounded-md bg-v2-background-bg-layer-01 p-2 text-[11px] font-[440] text-v2-state-fg-danger">{store.error}</div>
        </Show>

        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("work.home.discussion.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            icon="speech-bubble"
            onClick={start}
            disabled={starting() || store.topic.trim().length === 0}
          >
            {language.t("work.home.discussion.start")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
