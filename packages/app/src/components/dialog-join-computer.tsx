import { Show, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { createErrorDetailsCopy, friendlyErrorMessage } from "@/utils/error-message"
import type { ComputerPairJoinResult } from "@/computers"

// The dialog accepts the eight-character code with or without the dash, and
// never a full URL: the address is resolved by the main process against the
// configured control plane.
export function normalizeJoinCode(value: string): string {
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "")
  if (cleaned.length !== 8) return ""
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
}

export function DialogJoinComputer(props: { onPaired?: (result: ComputerPairJoinResult) => void }) {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const api = platform.computers
  const [store, setStore] = createStore({
    code: "",
    error: undefined as unknown,
    joining: false,
    paired: undefined as ComputerPairJoinResult | undefined,
  })
  const details = createErrorDetailsCopy()
  let autoClose: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (autoClose !== undefined) clearTimeout(autoClose)
  })

  const code = createMemo(() => normalizeJoinCode(store.code))

  const join = async () => {
    if (!api || store.joining) return
    if (code().length === 0) {
      setStore("error", language.t("settings.computers.pair.codeInvalid"))
      return
    }
    setStore("joining", true)
    try {
      const result = await api.pair.join(code())
      setStore("paired", result)
      setStore("error", undefined)
      props.onPaired?.(result)
      autoClose = setTimeout(() => dialog.close(), 1600)
    } catch (error) {
      setStore("error", error)
    } finally {
      setStore("joining", false)
    }
  }

  return (
    <Dialog
      title={language.t("settings.computers.pair.joinTitle")}
      description={language.t("settings.computers.pair.joinDescription")}
      fit
      class="[font-family:var(--v2-font-family-sans)]"
    >
      <div class="flex w-[520px] max-w-full flex-col gap-4 pl-6 pr-2.5 pb-3">
        <TextField
          label={language.t("settings.computers.pair.codeLabel")}
          placeholder={language.t("settings.computers.pair.codePlaceholder")}
          value={store.code}
          onChange={(value) => {
            setStore("code", value)
            setStore("error", undefined)
          }}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Enter" && code().length > 0 && store.paired === undefined) void join()
          }}
          disabled={store.paired !== undefined}
        />

        <Show when={store.paired}>
          <div class="rounded-md bg-v2-background-bg-layer-01 p-2 text-[13px] font-[440] text-v2-text-text-base">
            {language.t("settings.computers.pair.joined")}
          </div>
        </Show>

        <Show when={store.error}>
          <div class="flex flex-col gap-1 rounded-md bg-v2-background-bg-layer-01 p-2">
            <span class="text-[11px] font-[440] text-v2-state-fg-danger">
              {friendlyErrorMessage(store.error, language.t, "error.common.unknown")}
            </span>
            <button
              type="button"
              class="text-left text-[11px] font-[440] text-v2-text-text-muted underline underline-offset-2 hover:text-v2-text-text-base"
              onClick={() => void details.copy(store.error)}
            >
              {details.copied() ? language.t("error.common.detailsCopied") : language.t("error.common.copyDetails")}
            </button>
          </div>
        </Show>

        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("settings.computers.pair.close")}
          </Button>
          <Button
            variant="primary"
            size="large"
            onClick={() => void join()}
            disabled={store.joining || code().length === 0 || store.paired !== undefined}
          >
            {store.joining ? language.t("settings.computers.pair.joining") : language.t("settings.computers.pair.join")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
