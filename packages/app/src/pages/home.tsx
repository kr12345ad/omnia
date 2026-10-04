import { createEffect, createMemo, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useSettings } from "@/context/settings"
import { WorkHome } from "./home/work-home"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"
import { HomeUtilityNav } from "./home/home-projects-view"
import { HomeProjects } from "./home/home-projects"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessions } from "./home/home-sessions"

type HomeMode = "work" | "code"

export function NewHome() {
  const settings = useSettings()
  const mode = createMemo<HomeMode>(() => (settings.general.mode() === "work" ? "work" : "code"))
  const isCode = () => mode() === "code"
  // Entering direction for the slide: code arrives from the right, work from the
  // left. A plain memo of the mode, so the class the active home renders with is
  // correct on the very first paint (an effect would paint the previous
  // direction once). CSS drops the animation for prefers-reduced-motion.
  const slideClass = () => (isCode() ? "home-slide-in-right" : "home-slide-in-left")
  // A home is constructed the first time its mode becomes active and stays
  // mounted after that. Mounting both on first paint would build two sets of
  // controllers (scroll, search, projects) that race on the same shared state
  // while one of them is `display:none`; remounting an already-visited home would
  // throw away its controllers, refetch its data and make the switch feel like
  // it never opened. The active mode always mounts, so a mode that hydrates from
  // persisted settings after the first paint still renders.
  const [visited, setVisited] = createStore<Record<HomeMode, boolean>>({ work: false, code: false })
  const mounted = (next: HomeMode) => next === mode() || visited[next]
  createEffect(on(mode, (next) => setVisited(next, true)))

  // NOTE: `hidden` (display:none) must never compete with `flex` (display:flex) in
  // the same class list — drive display solely through classList or both show at
  // once. Only the active wrapper carries the slide class, so re-showing a kept
  // alive home replays the entrance animation.
  // The outer wrapper is flex-1 so children stretch full width/height.
  return (
    <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-clip contain-strict">
      <Show when={mounted("work")}>
        <div
          class="min-h-0 w-full min-w-0 flex-1 flex-col overflow-clip"
          classList={{
            hidden: isCode(),
            flex: !isCode(),
            [slideClass()]: !isCode(),
          }}
        >
          <WorkHome />
        </div>
      </Show>
      <Show when={mounted("code")}>
        <div
          class="min-h-0 w-full min-w-0 flex-1 flex-col overflow-clip"
          classList={{
            hidden: !isCode(),
            flex: isCode(),
            [slideClass()]: isCode(),
          }}
        >
          <CodeHome />
        </div>
      </Show>
    </div>
  )
}

function CodeHome() {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  return (
    <div
      class={`
        m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px]
        bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
      `}
    >
      <ScrollView
        class="h-full [container-type:size]"
        thumbContainer={scroll.viewport.thumbTrack}
        thumbHoverTarget={scroll.viewport.hoverTarget}
        viewportRef={scroll.viewport.setViewport}
        onScroll={(event) => scroll.viewport.update(event.currentTarget.scrollTop)}
        onWheel={scroll.viewport.containOuterWheel}
      >
        <div
          class={`
            mx-auto grid min-h-full w-full max-w-[1080px] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 px-3
            lg:grid-cols-[280px_minmax(0,720px)] lg:grid-rows-1 lg:gap-8 lg:px-6
          `}
        >
          <HomeProjects projects={projects} scroll={scroll} />
          <HomeSessions sessions={sessions} search={search} scroll={scroll} />
          <HomeUtilityNav
            class="flex lg:hidden"
            onOpenSettings={projects.utility.settings}
            onOpenHelp={projects.utility.help}
            language={projects.copy.language}
          />
        </div>
      </ScrollView>
    </div>
  )
}
