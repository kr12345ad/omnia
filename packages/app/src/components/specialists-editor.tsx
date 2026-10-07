import { For, Show, createEffect, createMemo, createUniqueId, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Paywall } from "@opencode-ai/ui/paywall"
import { TextField } from "@opencode-ai/ui/text-field"
import { checkoutPlan, useEntitlement } from "@/context/entitlement"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

type Api = NonNullable<ReturnType<typeof usePlatform>["specialists"]>
type Roster = Awaited<ReturnType<Api["get"]>>
type Specialist = Roster["specialists"][number]

interface Row {
  id: number
  role: string
  origName: string | undefined
  name: string
  focus: string
  touched: boolean
}

interface RowErrors {
  name?: string
  focus?: string
}

const ROLE = /^[a-z][a-z0-9-]{1,23}$/
const RESERVED = ["manager"]

function clean(name: string) {
  return name.replace(/\s+/g, " ").trim()
}

function slug(name: string) {
  const value = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "")
  return /^[a-z]/.test(value) ? value : `s-${value}`.slice(0, 24).replace(/-+$/g, "")
}

function keeps(row: Row) {
  return row.origName !== undefined && row.role.length > 0 && row.name === row.origName
}

function roleOf(row: Row) {
  return keeps(row) ? row.role : slug(clean(row.name))
}

function same(rows: readonly Row[], list: readonly Specialist[]) {
  if (rows.length !== list.length) return false
  return rows.every((row, index) => row.name.trim() === list[index].name && row.focus.trim() === list[index].focus)
}

export function SpecialistsEditor(props: { onCount?: (count: number | undefined) => void }) {
  const language = useLanguage()
  const platform = usePlatform()
  const entitlement = useEntitlement()
  const bodyId = createUniqueId()
  let list: HTMLDivElement | undefined
  const [store, setStore] = createStore({
    status: "loading" as "loading" | "ready" | "error",
    roster: undefined as Roster | undefined,
    rows: [] as Row[],
    seq: 0,
    open: false,
    attempted: false,
    busy: undefined as "save" | "reset" | undefined,
    confirm: false,
    saved: false,
    error: "",
  })

  const t = (key: string, params?: Record<string, string | number>) =>
    language.t(`work.home.discussion.specialists.${key}` as Parameters<typeof language.t>[0], params)

  const rowsOf = (specialists: readonly Specialist[], from: number): Row[] =>
    specialists.map((item, index) => ({
      id: from + index,
      role: item.role,
      origName: item.name,
      name: item.name,
      focus: item.focus,
      touched: false,
    }))

  const seed = (roster: Roster) => {
    setStore({
      roster,
      rows: rowsOf(roster.specialists, store.seq),
      seq: store.seq + roster.specialists.length,
      attempted: false,
      confirm: false,
      error: "",
    })
  }

  const load = () => {
    const api = platform.specialists
    if (api === undefined) return
    setStore({ status: "loading", error: "" })
    void api
      .get()
      .then((roster) => {
        seed(roster)
        setStore("status", "ready")
      })
      .catch(() => setStore("status", "error"))
  }

  onMount(load)

  const entitled = () => store.roster?.entitled === true
  const limits = () => store.roster?.limits
  const dirty = () => entitled() && store.roster !== undefined && !same(store.rows, store.roster.specialists)
  const atMax = () => store.rows.length >= (limits()?.maxCount ?? 0)
  const atMin = () => store.rows.length <= (limits()?.minCount ?? 0)
  const busy = () => store.busy !== undefined

  createEffect(() => props.onCount?.(entitled() ? store.roster?.specialists.length : undefined))

  const errors = createMemo<RowErrors[]>(() => {
    const max = limits()
    if (max === undefined) return []
    const roles = store.rows.map(roleOf)
    return store.rows.map((row, index) => {
      const result: RowErrors = {}
      const name = clean(row.name)
      const focus = row.focus.trim()
      const role = roles[index]
      if (name.length === 0) result.name = t("nameRequired")
      else if (name.length > max.maxNameLength) result.name = t("nameTooLong", { max: max.maxNameLength })
      else if (!ROLE.test(role)) result.name = t("nameUnusable")
      else if (RESERVED.includes(role)) result.name = t("nameReserved")
      else if (roles.filter((other) => other === role).length > 1) result.name = t("nameDuplicate")
      if (focus.length === 0) result.focus = t("focusRequired")
      else if (focus.length > max.maxFocusLength) result.focus = t("focusTooLong", { max: max.maxFocusLength })
      return result
    })
  })

  const invalid = () => errors().some((item) => item.name !== undefined || item.focus !== undefined)
  const visible = (row: Row, field: keyof RowErrors) =>
    store.attempted || row.touched ? errors()[store.rows.indexOf(row)]?.[field] : undefined

  const edit = (id: number, field: "name" | "focus", value: string) => {
    setStore("rows", (row) => row.id === id, { [field]: value, touched: true })
    setStore({ saved: false, error: "", confirm: false })
  }

  const add = () => {
    if (atMax() || busy()) return
    const id = store.seq
    setStore("seq", id + 1)
    setStore("rows", store.rows.length, { id, role: "", origName: undefined, name: "", focus: "", touched: false })
    setStore({ saved: false, error: "", confirm: false })
    queueMicrotask(() => list?.querySelector<HTMLInputElement>(`[data-row="${id}"] input`)?.focus())
  }

  const remove = (id: number) => {
    if (atMin() || busy()) return
    setStore("rows", (rows) => rows.filter((row) => row.id !== id))
    setStore({ saved: false, error: "", confirm: false })
  }

  const fail = (error: unknown) =>
    setStore({ error: error instanceof Error ? error.message : String(error), busy: undefined })

  const save = () => {
    const api = platform.specialists
    if (api === undefined || busy() || !dirty()) return
    setStore({ attempted: true, saved: false, error: "" })
    if (invalid()) return
    setStore("busy", "save")
    void api
      .save(
        store.rows.map((row) => ({
          role: keeps(row) ? row.role : "",
          name: clean(row.name),
          focus: row.focus.trim(),
        })),
      )
      .then((roster) => {
        seed(roster)
        setStore({ busy: undefined, saved: true })
      })
      .catch(fail)
  }

  const resettable = () => {
    const roster = store.roster
    return roster !== undefined && (roster.custom || !same(store.rows, roster.defaults))
  }

  const reset = () => {
    const api = platform.specialists
    const roster = store.roster
    if (api === undefined || roster === undefined || busy()) return
    if (!roster.custom) {
      setStore({
        rows: rowsOf(roster.defaults, store.seq),
        seq: store.seq + roster.defaults.length,
        attempted: false,
        saved: false,
        error: "",
        confirm: false,
      })
      return
    }
    if (!store.confirm) {
      setStore("confirm", true)
      return
    }
    setStore({ busy: "reset", confirm: false, saved: false, error: "" })
    void api
      .reset()
      .then((next) => {
        seed(next)
        setStore({ busy: undefined, saved: true })
      })
      .catch(fail)
  }

  const names = createMemo(() => {
    const roster = store.roster
    if (roster === undefined) return ""
    return new Intl.ListFormat(language.intl(), { style: "narrow", type: "conjunction" }).format(
      roster.specialists.map((item) => item.name),
    )
  })

  const upgrade = () =>
    entitlement.account()?.billingConfigured === true ? () => void checkoutPlan(platform, language, "pro") : undefined

  return (
    <Show when={platform.specialists}>
      <div
        class="flex flex-col gap-2 rounded-md border border-v2-border-border-muted p-3"
        data-component="specialists-editor"
      >
        <Show when={store.status === "loading"}>
          <div class="text-[11px] font-[440] text-v2-text-text-muted" role="status">
            {t("loading")}
          </div>
        </Show>

        <Show when={store.status === "error"}>
          <div class="flex items-center justify-between gap-2">
            <span class="text-[11px] font-[440] text-v2-text-text-muted" role="status">
              {t("loadFailed")}
            </span>
            <Button variant="ghost" size="small" onClick={load}>
              {t("retry")}
            </Button>
          </div>
        </Show>

        <Show when={store.status === "ready" && store.roster}>
          {(roster) => (
            <>
              <div class="flex items-center justify-between gap-2">
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="text-[13px] font-[530] text-v2-text-text-base">{t("title")}</span>
                  <span class="truncate text-[11px] font-[440] text-v2-text-text-muted">{names()}</span>
                  <Show when={dirty()}>
                    <span class="text-[11px] font-[530] text-v2-text-text-base" data-slot="specialists-unsaved">
                      {t("unsaved")}
                    </span>
                  </Show>
                </div>
                <Button
                  variant="ghost"
                  size="small"
                  aria-expanded={store.open}
                  aria-controls={bodyId}
                  onClick={() => setStore("open", !store.open)}
                >
                  {store.open ? t("hide") : roster().entitled ? t("customize") : t("view")}
                </Button>
              </div>

              <Show when={store.open}>
                <div id={bodyId} class="flex flex-col gap-3">
                  <Show
                    when={roster().entitled}
                    fallback={
                      <>
                        <div class="text-[11px] font-[440] text-v2-text-text-muted">{t("defaultsNote")}</div>
                        <ul
                          class="flex max-h-[240px] flex-col gap-2 overflow-y-auto pr-1"
                          data-slot="specialists-defaults"
                        >
                          <For each={roster().defaults}>
                            {(item) => (
                              <li class="flex flex-col gap-0.5 rounded-md bg-v2-background-bg-layer-01 p-2">
                                <span class="text-[13px] font-[530] text-v2-text-text-base">{item.name}</span>
                                <span class="text-[11px] font-[440] text-v2-text-text-muted">{item.focus}</span>
                              </li>
                            )}
                          </For>
                        </ul>
                        <Paywall
                          capability="custom_specialists"
                          decision={{ code: "not_entitled" }}
                          offer={{ onUpgrade: upgrade() }}
                        />
                      </>
                    }
                  >
                    <div
                      ref={list}
                      class="flex max-h-[320px] flex-col gap-2 overflow-y-auto pr-1"
                      data-slot="specialists-list"
                    >
                      <For each={store.rows}>
                        {(row, index) => (
                          <div
                            data-row={row.id}
                            class="flex flex-col gap-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-2"
                          >
                            <div class="flex items-start gap-2">
                              <div class="min-w-0 flex-1">
                                <TextField
                                  label={t("nameLabel", { index: index() + 1 })}
                                  hideLabel
                                  placeholder={t("namePlaceholder")}
                                  value={row.name}
                                  disabled={busy()}
                                  validationState={visible(row, "name") === undefined ? "valid" : "invalid"}
                                  error={visible(row, "name")}
                                  description={t("counter", {
                                    used: clean(row.name).length,
                                    max: limits()?.maxNameLength ?? 0,
                                  })}
                                  onChange={(value) => edit(row.id, "name", value)}
                                />
                              </div>
                              <IconButton
                                icon="trash"
                                variant="ghost"
                                size="small"
                                class="mt-1 motion-reduce:transition-none"
                                aria-label={t("remove", { index: index() + 1 })}
                                disabled={atMin() || busy()}
                                onClick={() => remove(row.id)}
                              />
                            </div>
                            <TextField
                              multiline
                              label={t("focusLabel", { index: index() + 1 })}
                              hideLabel
                              placeholder={t("focusPlaceholder")}
                              value={row.focus}
                              disabled={busy()}
                              validationState={visible(row, "focus") === undefined ? "valid" : "invalid"}
                              error={visible(row, "focus")}
                              description={t("counter", {
                                used: row.focus.trim().length,
                                max: limits()?.maxFocusLength ?? 0,
                              })}
                              onChange={(value) => edit(row.id, "focus", value)}
                            />
                          </div>
                        )}
                      </For>
                    </div>

                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <Button
                        variant="secondary"
                        size="small"
                        icon="plus-small"
                        disabled={atMax() || busy()}
                        onClick={add}
                      >
                        {t("add")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="small"
                        icon="reset"
                        disabled={!resettable() || busy()}
                        onClick={reset}
                        onBlur={() => setStore("confirm", false)}
                      >
                        {store.busy === "reset" ? t("resetting") : store.confirm ? t("resetConfirm") : t("reset")}
                      </Button>
                    </div>
                    <Show when={atMax() || atMin()}>
                      <div class="text-[11px] font-[440] text-v2-text-text-muted">
                        {atMax()
                          ? t("maxHint", { max: limits()?.maxCount ?? 0 })
                          : t("minHint", { min: limits()?.minCount ?? 0 })}
                      </div>
                    </Show>

                    <Show when={store.error}>
                      <div
                        class="rounded-md bg-v2-background-bg-layer-01 p-2 text-[11px] font-[440] text-v2-state-fg-danger"
                        role="alert"
                      >
                        {store.error}
                      </div>
                    </Show>
                    <Show when={store.attempted && invalid()}>
                      <div class="text-[11px] font-[440] text-v2-state-fg-danger" role="alert">
                        {t("invalid")}
                      </div>
                    </Show>
                    <Show when={store.saved && !dirty()}>
                      <div class="text-[11px] font-[440] text-v2-text-text-muted" role="status">
                        {t("saved")}
                      </div>
                    </Show>
                    <Show when={dirty()}>
                      <div class="text-[11px] font-[440] text-v2-text-text-muted">{t("unsavedHint")}</div>
                    </Show>

                    <div class="flex justify-end">
                      <Button variant="primary" size="small" disabled={!dirty() || busy()} onClick={save}>
                        {store.busy === "save" ? t("saving") : t("save")}
                      </Button>
                    </div>
                  </Show>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}
