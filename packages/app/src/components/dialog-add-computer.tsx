import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { createErrorDetailsCopy, friendlyErrorMessage } from "@/utils/error-message"
import type { ComputerPairing } from "@/computers"

export function DialogAddComputer(props: { existing: string[]; onPaired?: (id: string) => void }) {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const api = platform.computers
  const [store, setStore] = createStore({
    pairing: undefined as ComputerPairing | undefined,
    error: undefined as unknown,
    loading: true,
    pairedName: "",
    copied: "" as "" | "code" | "command",
  })
  const details = createErrorDetailsCopy()
  let poll: ReturnType<typeof setInterval> | undefined
  let autoClose: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const [now, setNow] = createSignal(Date.now())
  let clock: ReturnType<typeof setInterval> | undefined

  const stopPolling = () => {
    if (poll !== undefined) clearInterval(poll)
    poll = undefined
  }

  const stopClock = () => {
    if (clock !== undefined) clearInterval(clock)
    clock = undefined
  }

  const remainingMs = () => {
    const pairing = store.pairing
    if (pairing === undefined || typeof pairing.expiresAt !== "number") return undefined
    return Math.max(0, pairing.expiresAt - now())
  }

  const remainingText = () => {
    const remaining = remainingMs()
    if (remaining === undefined) return ""
    const total = Math.ceil(remaining / 1000)
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
  }

  const create = () => {
    if (!api) {
      setStore("error", language.t("settings.computers.unavailable"))
      setStore("loading", false)
      return
    }
    const previous = store.pairing
    if (previous !== undefined && store.pairedName.length === 0) {
      void api.pair.cancel(previous.code).catch(() => undefined)
    }
    stopPolling()
    stopClock()
    setStore("loading", true)
    setStore("error", undefined)
    setStore("pairing", undefined)
    setStore("pairedName", "")
    void api.pair
      .create()
      .then((pairing) => {
        if (disposed) {
          void api.pair.cancel(pairing.code).catch(() => undefined)
          return
        }
        setStore("pairing", pairing)
        setStore("loading", false)
        stopClock()
        clock = setInterval(() => setNow(Date.now()), 1000)
        poll = setInterval(() => {
          void api
            .list()
            .then((computers) => {
              const fresh = computers.find((computer) => !props.existing.includes(computer.id))
              if (fresh === undefined) return
              stopPolling()
              stopClock()
              setStore("pairedName", fresh.name)
              props.onPaired?.(fresh.id)
              autoClose = setTimeout(() => {
                if (!disposed) close()
              }, 1800)
            })
            .catch(() => undefined)
        }, 2000)
      })
      .catch((error) => {
        setStore("error", error)
        setStore("loading", false)
      })
  }

  const close = () => {
    stopPolling()
    stopClock()
    const pairing = store.pairing
    if (pairing !== undefined && store.pairedName.length === 0) {
      void api?.pair.cancel(pairing.code).catch(() => undefined)
    }
    dialog.close()
  }

  onMount(() => {
    create()
  })

  onCleanup(() => {
    disposed = true
    stopPolling()
    stopClock()
    if (autoClose !== undefined) clearTimeout(autoClose)
  })

  const copy = async (kind: "code" | "command", value: string) => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // A rejected clipboard write must never claim the text was copied.
      setStore("error", language.t("error.common.clipboard"))
      return
    }
    setStore("error", undefined)
    setStore("copied", kind)
    setTimeout(() => setStore("copied", ""), 1500)
  }

  const isLoopback = () => store.pairing?.serverUrl.includes("127.0.0.1") === true

  return (
    <Dialog
      title={language.t("settings.computers.pair.title")}
      description={language.t("settings.computers.pair.description")}
      fit
      class="[font-family:var(--v2-font-family-sans)]"
    >
      <div class="flex w-[520px] max-w-full flex-col gap-4 pl-6 pr-2.5 pb-3">
        <Show when={store.loading}>
          <div class="text-[13px] font-[440] text-v2-text-text-muted">
            {language.t("settings.computers.pair.preparing")}
          </div>
        </Show>

        <Show when={store.pairing}>
          {(offer) => (
            <div class="flex flex-col gap-4">
              <div class="flex flex-col gap-2">
                <span class="text-[13px] font-[530] text-v2-text-text-muted">
                  {language.t("settings.computers.pair.code")}
                </span>
                <div class="flex items-center gap-2">
                  <span class="flex-1 rounded-md bg-v2-background-bg-layer-01 px-3 py-2 font-mono text-[15px] font-[640] tracking-wide text-v2-text-text-base">
                    {offer().code}
                  </span>
                  <Button variant="secondary" size="small" icon="copy" onClick={() => void copy("code", offer().code)}>
                    {store.copied === "code"
                      ? language.t("settings.computers.pair.copied")
                      : language.t("settings.computers.pair.copyCode")}
                  </Button>
                </div>
                <span class="text-[11px] font-[440] text-v2-text-text-muted">
                  {language.t("settings.computers.pair.codeHint")}
                </span>
              </div>

              <Show when={isLoopback()}>
                <div class="rounded-md bg-v2-background-bg-layer-01 p-2 text-[11px] font-[440] text-v2-text-text-muted">
                  {language.t("settings.computers.pair.loopback")}
                </div>
              </Show>

              <Show
                when={store.pairedName.length > 0}
                fallback={
                  <Show
                    when={(remainingMs() ?? 1) > 0}
                    fallback={
                      <div class="flex flex-col gap-2">
                        <div class="rounded-md bg-v2-background-bg-layer-01 p-2 text-[13px] font-[440] text-v2-state-fg-danger">
                          {language.t("settings.computers.pair.expired")}
                        </div>
                        <div>
                          <Button variant="secondary" size="small" onClick={() => create()}>
                            {language.t("settings.computers.pair.newCode")}
                          </Button>
                        </div>
                      </div>
                    }
                  >
                    <div class="text-[13px] font-[440] text-v2-text-text-muted">
                      {language.t("settings.computers.pair.waiting")}
                    </div>
                    <div class="text-[11px] font-[440] text-v2-text-text-muted">
                      {language.t("settings.computers.pair.expiresIn", { time: remainingText() })}
                    </div>
                  </Show>
                }
              >
                <div class="rounded-md bg-v2-background-bg-layer-01 p-2 text-[13px] font-[440] text-v2-text-text-base">
                  {language.t("settings.computers.pair.paired", { name: store.pairedName })}
                </div>
              </Show>
            </div>
          )}
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
          <Button variant="ghost" size="large" onClick={close}>
            {language.t("settings.computers.pair.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
