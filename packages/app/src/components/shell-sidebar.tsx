import { makeEventListener } from "@solid-primitives/event-listener"
import { A, useParams } from "@solidjs/router"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, type JSX } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Avatar } from "@opencode-ai/ui/v2/avatar-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { WordmarkV2 } from "@opencode-ai/ui/v2/wordmark-v2"
import { useSettingsDialog } from "@/components/settings-dialog"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { useEntitlement } from "@/context/entitlement"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { errorMessage, sortedRootSessions } from "@/pages/layout/helpers"
import { sessionPermissionRequest } from "@/pages/session/composer/session-request-tree"
import { decode64 } from "@/utils/base64"
import { sessionHref } from "@/utils/session-route"
import { sessionTitle } from "@/utils/session-title"
import { showToast } from "@/utils/toast"
import "./shell-sidebar.css"

const DAY = 24 * 60 * 60 * 1000

// The shell's own row idiom (`home-projects-view.tsx`): 28px rows on the app's
// type scale, layer surfaces on hover and selection, no outlines, no dividers.
// A sidebar drawn from the same idiom reads as part of the window instead of a
// panel bolted onto it.
//
// `shell-sidebar-row` is the hook the stylesheet uses to reshape a row into the
// collapsed rail. Every row is one element in one tree: the column and the rail
// are the same markup at two widths, so collapsing reflows instead of swapping.
//
// `px-3` (12px) is the one inset shared with the titlebar's reveal button and
// the collapsed rail: the row box starts at the column's 8px gutter, so every
// glyph — action, session, avatar — sits on the same 16px line at x=20, and the
// rail keeps that line while its rows become 32px squares.
const ROW_BASE =
  "shell-sidebar-row group relative flex shrink-0 cursor-default items-center rounded-[6px] bg-transparent text-left [font-weight:440] tracking-[-0.04px] text-v2-text-text-muted transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base data-[selected]:bg-v2-background-bg-layer-03 data-[selected]:[font-weight:530] data-[selected]:text-v2-text-text-base data-[selected]:hover:bg-v2-background-bg-layer-03 focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-base focus-visible:outline-none focus-visible:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]"
/** A row that fills the column: an icon and a label. */
const ROW = `${ROW_BASE} min-w-0 w-full gap-2 px-3 text-[13px]`
const ROW_ICON = "flex size-4 shrink-0 items-center justify-center text-v2-icon-icon-muted transition-colors group-hover:text-v2-icon-icon-base"
/** The rail's version of a session row: the title's first letter. */
const ROW_LETTER = "flex size-4 shrink-0 items-center justify-center text-[11px] uppercase"
const ROW_LABEL = "min-w-0 flex-1 truncate"

/**
 * The v2 shell's conversation sidebar: a permanent left column that collapses to
 * an icon rail.
 *
 * It is the session list for the project in the address bar, grouped by recency
 * the way a chat product groups conversations, with the primary actions at the
 * top (new session, search) and the utility rows at the bottom (settings,
 * account, help). The collapsed rail is the same rows as icons, so nothing in
 * the column ever disappears — it only gets smaller.
 */
export function ShellSidebar() {
  const language = useLanguage()
  const layout = useLayout()
  const platform = usePlatform()
  const server = useServer()
  const sync = useServerSync()
  const tabs = useTabs()
  const params = useParams<{ dir?: string; id?: string }>()
  const entitlement = useEntitlement()
  const openSettings = useSettingsDialog()
  const openAccount = useSettingsDialog("account")
  const [searching, setSearching] = createSignal(false)
  const [query, setQuery] = createSignal("")
  let searchBox: HTMLDivElement | undefined

  const collapsed = () => layout.sidebar.collapsed()
  // The field exists only while the column is open, so the row's disclosure
  // state is derived from both. The pressed surface is what the row paints when
  // its field is on screen; deriving it here is what stops a "searching" row
  // from being left pressed with nothing to point at — the state the rail used
  // to keep forever.
  const searchOpen = () => searching() && !collapsed()
  const projects = createMemo(() => layout.projects.list())
  // The address bar wins: a shared session link can point at a sandbox that is
  // not the first open project.
  const directory = createMemo(() => decode64(params.dir) ?? projects()[0]?.worktree)
  const child = createMemo(() => (directory() ? sync().child(directory()!) : undefined))
  const sessions = createMemo(() => {
    const store = child()?.[0]
    if (!store) return [] as Session[]
    return sortedRootSessions({ session: store.session, path: { directory: directory()! } }, Date.now())
  })
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase()
    if (!needle) return sessions()
    return sessions().filter((session) => (title(session) ?? "").toLowerCase().includes(needle))
  })
  const groups = createMemo(() => {
    const today = startOfDay(Date.now())
    const yesterday = today - DAY
    const buckets = [
      { label: language.t("home.sessions.group.today"), items: [] as Session[] },
      { label: language.t("home.sessions.group.yesterday"), items: [] as Session[] },
      { label: language.t("home.sessions.group.older"), items: [] as Session[] },
    ]
    for (const session of filtered()) {
      const at = session.time.updated ?? session.time.created
      if (at >= today) buckets[0].items.push(session)
      else if (at >= yesterday) buckets[1].items.push(session)
      else buckets[2].items.push(session)
    }
    return buckets.filter((bucket) => bucket.items.length > 0)
  })

  const title = (session: Session) => sessionTitle(session.title) ?? language.t("command.session.new")

  const openNewSession = () => {
    const dir = directory()
    if (!dir) return
    void tabs.newDraft({ server: server.key, directory: dir })
  }

  // A rail has no room for a field, so the same click opens the column first.
  // The caret is placed on the next frame rather than by `autofocus`: the row
  // becomes the field in place, so the box has to be ready to type into even
  // when it was already mounted (hidden) behind a collapsed rail. The input is
  // looked up fresh and only focused while it is still in the document, because
  // the ref can still name the copy the last close removed.
  const focusSearch = () => {
    // The field is hidden by the rail's container query until the column has
    // widened past it, so focus is retried for a few frames: a single call can
    // land on an input that is still `display:none`, where focus() does nothing.
    const attempt = (frames: number) => {
      const input = searchBox?.querySelector("input")
      if (input?.getClientRects().length) {
        input.focus()
        return
      }
      if (frames > 0) requestAnimationFrame(() => attempt(frames - 1))
    }
    requestAnimationFrame(() => attempt(30))
  }

  const openSearch = () => {
    if (collapsed()) layout.sidebar.setCollapsed(false)
    setSearching(true)
    focusSearch()
  }

  const closeSearch = () => {
    setSearching(false)
    setQuery("")
  }

  // Search belongs to the expanded column: collapsing ends it, so a rail never
  // carries a filter that nothing on screen explains and no control can clear.
  createEffect(() => {
    if (collapsed()) closeSearch()
  })

  // A press anywhere else ends the search too. Without this the field — a box
  // drawn over the row it replaced — just sat there after the user clicked away,
  // looking like the row was still pressed and leaving no way to dismiss it but
  // Escape. A press inside a session row's own box is deliberately left alone —
  // that includes the delete action beside the link, whose click cannot survive
  // the list reflowing out from under the pointer: the row's click ends the
  // search, and the action closes it on the way out.
  makeEventListener(document, "pointerdown", (event) => {
    if (!searchOpen()) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('[data-slot="shell-sidebar-search"]')) return
    if (target.closest('[data-slot="shell-sidebar-session-row"]')) return
    closeSearch()
  })

  const account = () => entitlement.account()?.profile?.login

  return (
    <aside
      data-component="shell-sidebar"
      data-collapsed={collapsed() ? "" : undefined}
      aria-label={language.t("sidebar.nav.projectsAndSessions")}
    >
      {/* The reveal control lives in the titlebar's left corner, so it stays in
          one place whether the column is open or a rail. This header only
          brands the column. */}
      <div data-slot="shell-sidebar-header" class="flex h-8 shrink-0 items-center px-2">
        <div data-slot="shell-sidebar-brand" class="flex min-w-0 flex-1 items-center px-3">
          <WordmarkV2 class="h-[11px] w-auto text-v2-text-text-inverse opacity-70" />
        </div>
      </div>

      <div data-slot="shell-sidebar-actions" class="flex shrink-0 flex-col gap-1 px-2 pt-1">
        <SidebarAction
          collapsed={collapsed()}
          icon={<IconV2 name="edit" size="small" />}
          label={language.t("command.session.new")}
          onSelect={openNewSession}
        />
        {/* One slot in two states: the action row becomes the field in place, so
            the session list below never moves when search opens. */}
        <div
          data-slot="shell-sidebar-search"
          data-searching={searchOpen() ? "" : undefined}
          class="flex shrink-0 flex-col"
        >
          <SidebarAction
            collapsed={collapsed()}
            icon={<IconV2 name="magnifying-glass" size="small" />}
            label={language.t("home.sessions.search.placeholder")}
            selected={searchOpen()}
            onSelect={openSearch}
          />
          <Show when={searchOpen()}>
            <div
              data-slot="shell-sidebar-search-field"
              class="shell-sidebar-expanded flex"
              ref={(element) => (searchBox = element)}
            >
              <TextInputV2
                autofocus
                class="!w-full"
                value={query()}
                placeholder={language.t("home.sessions.search.placeholder")}
                leadingIcon={<IconV2 name="magnifying-glass" size="small" />}
                showClearButton={query().length > 0}
                onClearClick={() => setQuery("")}
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return
                  event.preventDefault()
                  closeSearch()
                }}
                aria-label={language.t("home.sessions.search.placeholder")}
              />
            </div>
          </Show>
        </div>
      </div>

      <nav
        id="shell-sidebar-sessions"
        data-slot="shell-sidebar-sessions"
        class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto no-scrollbar px-2 py-2"
      >
        <For each={groups()}>
          {(group) => (
            <div data-slot="shell-sidebar-group" class="flex min-w-0 flex-col gap-1">
              <div
                data-slot="shell-sidebar-group-label"
                class="shell-sidebar-expanded flex h-7 min-w-0 items-center px-3 text-v2-text-text-faint [font-weight:530] tracking-[-0.04px]"
              >
                <span class="min-w-0 truncate">{group.label}</span>
              </div>
              <For each={group.items}>
                {(session) => (
                  <SessionLink session={session} active={params.id === session.id} onOpen={closeSearch} />
                )}
              </For>
            </div>
          )}
        </For>
        <Show when={groups().length === 0}>
          <div
            data-slot="shell-sidebar-empty"
            class="shell-sidebar-expanded flex flex-col gap-1 px-3 py-4 text-center"
          >
            <span class="text-[13px] [font-weight:440] tracking-[-0.04px] text-v2-text-text-muted">
              {query()
                ? language.t("home.sessions.search.noResults", { query: query() })
                : language.t("home.sessions.empty")}
            </span>
            <Show when={!query()}>
              <span class="text-[12px] text-v2-text-text-faint tracking-[-0.04px]">
                {language.t("home.sessions.empty.description")}
              </span>
            </Show>
          </div>
        </Show>
      </nav>

      <div data-slot="shell-sidebar-footer" class="flex shrink-0 flex-col gap-1 p-2">
        <SidebarAction
          collapsed={collapsed()}
          icon={<IconV2 name="settings-gear" size="small" />}
          label={language.t("sidebar.settings")}
          onSelect={() => openSettings()}
        />
        <SidebarAction
          collapsed={collapsed()}
          icon={<IconV2 name="help" size="small" />}
          label={language.t("sidebar.help")}
          onSelect={() => platform.openExternal("https://opencode.ai/desktop-feedback")}
        />
        <SidebarAction
          collapsed={collapsed()}
          label={account() ?? language.t("desktop.menu.account")}
          icon={<Avatar size="small" fallback={account() ?? language.t("desktop.menu.account")} />}
          onSelect={() => openAccount()}
        />
      </div>
    </aside>
  )
}

/**
 * One conversation row. Widened it is the title; in the rail it is the first
 * letter of that title, so the rail stays readable as a column of conversations
 * instead of a column of identical glyphs.
 *
 * It also carries the session's state — running, asking for permission, failed,
 * or finished while you were elsewhere — which is the one thing this list has to
 * say that a title cannot.
 */
function SessionLink(props: { session: Session; active: boolean; onOpen: () => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  const server = useServer()
  const sync = useServerSync()
  const notification = useNotification()
  const permission = usePermission()
  const [store] = sync().child(props.session.directory)
  const title = () => sessionTitle(props.session.title) ?? language.t("command.session.new")
  const initial = () => title().trim().slice(0, 1)
  const working = () => sync().session.data.session_working(props.session.id)
  const unseen = () => notification.session.unseenCount(props.session.id)
  const failed = () => notification.session.unseenHasError(props.session.id)
  const asking = () =>
    !!sessionPermissionRequest(store.session, sync().session.data.permission, props.session.id, (item) =>
      !permission.autoResponds(item, props.session.directory),
    )
  const state = () => {
    if (asking()) return "permission"
    if (working()) return "working"
    if (failed()) return "error"
    if (unseen() > 0) return "unseen"
    return undefined
  }

  return (
    <div
      data-slot="shell-sidebar-session-row"
      // The wrapper is the row's box: the revealed action is positioned against
      // it and it keeps the row lit while the pointer is on that action, which
      // sits beside the link so a button never nests inside an anchor.
      class="group/row relative w-full min-w-0 shrink-0 rounded-[6px] transition-[background-color] duration-[120ms] ease-in-out hover:bg-v2-background-bg-layer-01"
    >
      <A
        href={sessionHref(server.key, props.session.id)}
        // Opening a result is the end of the search: the row it was found through
        // is not a filter that outlives the click.
        onClick={props.onOpen}
        data-slot="shell-sidebar-session"
        data-selected={props.active ? "" : undefined}
        data-state={state()}
        aria-current={props.active ? "page" : undefined}
        aria-label={title()}
        class={ROW}
      >
        <span data-slot="shell-sidebar-session-icon" class={ROW_LETTER}>
          {initial()}
        </span>
        <span data-slot="shell-sidebar-label" class={ROW_LABEL}>
          {title()}
        </span>
        {/* The action's room is reserved inside the row instead of by padding,
            so the label shortens as the action arrives and the state dot slides
            left rather than being painted over. */}
        <span
          data-slot="shell-sidebar-session-action-space"
          aria-hidden="true"
          class="shell-sidebar-expanded w-0 shrink-0 transition-[width] duration-[120ms] ease-in-out group-hover/row:w-7 group-focus-within/row:w-7"
        />
        <span data-slot="shell-sidebar-state" class="shrink-0" classList={{ hidden: !state() }}>
          <Switch>
            <Match when={state() === "working"}>
              <Spinner class="size-3" />
            </Match>
            <Match when={state() === "permission"}>
              <span class="block size-1.5 rounded-full bg-surface-warning-strong" />
            </Match>
            <Match when={state() === "error"}>
              <span class="block size-1.5 rounded-full bg-text-diff-delete-base" />
            </Match>
            <Match when={true}>
              <span class="block size-1.5 rounded-full bg-text-interactive-base" />
            </Match>
          </Switch>
        </span>
      </A>
      <span
        data-slot="shell-sidebar-session-actions"
        class="shell-sidebar-expanded pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity duration-[120ms] ease-in-out group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100"
      >
        <IconButtonV2
          type="button"
          variant="ghost"
          size="small"
          class="size-6 rounded-md"
          icon={<IconV2 name="trash" size="small" />}
          data-slot="shell-sidebar-session-delete"
          aria-label={language.t("session.delete.button")}
          onClick={() => dialog.show(() => <DialogDeleteSession session={props.session} name={title()} />)}
        />
      </span>
    </div>
  )
}

/**
 * Deleting a conversation cannot be undone, so the row's action asks first:
 * the same confirm the session menu opens, so a delete reads the same wherever
 * it starts.
 */
function DialogDeleteSession(props: { session: Session; name: string }) {
  const language = useLanguage()
  const dialog = useDialog()
  const server = useServer()
  const serverSDK = useServerSDK()

  const remove = async () => {
    const removed = await serverSDK()
      .ensureDirSdkContext(props.session.directory)
      .api.session.remove({ sessionID: props.session.id })
      .then(() => true)
      .catch((error) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(error, language.t("common.requestFailed")),
        })
        return false
      })
    // The row goes when the server's own `session.deleted` event lands; an open
    // tab is this client's state, so it is dropped here.
    if (removed) {
      notifySessionTabsRemoved({
        server: server.key,
        directory: props.session.directory,
        sessionIDs: [props.session.id],
      })
    }
    dialog.close()
  }

  return (
    <DialogV2 fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("session.delete.title")}
          description={language.t("session.delete.confirm", { name: props.name })}
        />
      </DialogHeader>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="danger" onClick={remove}>
          {language.t("session.delete.button")}
        </ButtonV2>
      </DialogFooter>
    </DialogV2>
  )
}

/**
 * An action row: an icon, a label, and the app's own hover and selection
 * surfaces. It is the same element in both states — the tooltip activates and
 * the label drops out with the column's width.
 */
function SidebarAction(props: {
  collapsed: boolean
  icon: JSX.Element
  label: string
  selected?: boolean
  onSelect: () => void
}) {
  return (
    <TooltipV2 placement="right" value={props.label} inactive={!props.collapsed}>
      <button
        type="button"
        data-slot="shell-sidebar-action"
        data-selected={props.selected ? "" : undefined}
        onClick={props.onSelect}
        aria-label={props.label}
        aria-expanded={props.selected}
        class={ROW}
      >
        <span data-slot="shell-sidebar-icon" class={ROW_ICON}>
          {props.icon}
        </span>
        <span data-slot="shell-sidebar-label" class={ROW_LABEL}>
          {props.label}
        </span>
      </button>
    </TooltipV2>
  )
}

function startOfDay(at: number) {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}
