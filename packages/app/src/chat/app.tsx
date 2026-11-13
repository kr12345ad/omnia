import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import {
  ChatApi,
  ChatApiError,
  chatTitle,
  mergeLive,
  toRenderedMessages,
  type ChatModel,
  type ChatSession,
} from "./api"
import "./chat.css"

const MODEL_KEY = "omnia.chat.model"

const SUGGESTIONS = [
  "Explain a concept I'm curious about",
  "Help me think through a decision",
  "Draft something I can send",
]

export function ChatApp(props: {
  baseUrl: string
  headers?: Record<string, string>
  // undefined keeps the web chat behaviour (open the most recent session);
  // a session id opens that session; null starts on the session list so the
  // mobile shell can show the drawer first.
  initialSessionID?: string | null
}) {
  const api = new ChatApi({ baseUrl: props.baseUrl, headers: props.headers })
  const [models, setModels] = createSignal<ChatModel[]>([])
  const [sessions, setSessions] = createSignal<ChatSession[]>([])
  const [sessionID, setSessionID] = createSignal<string>()
  const [messages, setMessages] = createSignal(toRenderedMessages([]))
  const [live, setLive] = createSignal<Record<string, string>>({})
  const [input, setInput] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [modelKey, setModelKey] = createSignal<string>()
  const [sidebarOpen, setSidebarOpen] = createSignal(false)

  let textarea: HTMLTextAreaElement | undefined
  let scroller: HTMLDivElement | undefined
  let stick = true
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  const rendered = createMemo(() => mergeLive(messages(), live()))
  const lastAssistantID = createMemo(() => rendered().findLast((entry) => entry.role === "assistant")?.id)
  const currentSession = createMemo(() => sessions().find((session) => session.id === sessionID()))
  const title = createMemo(() => currentSession()?.title || "New chat")
  const currentModel = createMemo(
    () => models().find((model) => key(model) === modelKey()) ?? models()[0],
  )

  onMount(() => {
    void boot()
    const controller = new AbortController()
    void listen(controller.signal)
    onCleanup(() => {
      controller.abort()
      if (refreshTimer) clearTimeout(refreshTimer)
    })
  })

  createEffect(() => {
    input()
    grow()
  })

  createEffect(() => {
    rendered()
    busy()
    if (stick) queueMicrotask(() => scrollToBottom())
  })

  async function boot() {
    try {
      const location = await api.location()
      const [modelList, sessionList] = await Promise.all([api.models(location.directory), api.sessions(location.directory)])
      setModels(modelList)
      setSessions(sessionList)
      const stored = localStorage.getItem(MODEL_KEY)
      const chosen = modelList.find((model) => key(model) === stored) ?? modelList[0]
      if (chosen) setModelKey(key(chosen))
      const target = props.initialSessionID === null ? undefined : (props.initialSessionID ?? sessionList[0]?.id)
      if (target) await openSession(target)
      else {
        if (props.initialSessionID === null) setSidebarOpen(true)
        setLoading(false)
      }
    } catch (err) {
      setError(message(err))
      setLoading(false)
    }
  }

  async function openSession(id: string) {
    setSessionID(id)
    setLive({})
    setError(undefined)
    setSidebarOpen(false)
    setLoading(true)
    stick = true
    try {
      const [list, active] = await Promise.all([api.messages(id), api.active()])
      if (sessionID() !== id) return
      setMessages(toRenderedMessages(list))
      setBusy(active[id]?.type === "running")
      const session = sessions().find((entry) => entry.id === id)
      if (session?.model) setModelKey(key(session.model))
    } catch (err) {
      setError(message(err))
    } finally {
      if (sessionID() === id) setLoading(false)
      queueMicrotask(() => {
        scrollToBottom()
        textarea?.focus()
      })
    }
  }

  async function listen(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        for await (const event of api.events(signal)) handle(event)
        // A clean end is still a disconnect; do not spin on reconnect.
        if (signal.aborted) return
        await wait(1000)
      } catch {
        if (signal.aborted) return
        await wait(1000)
      }
    }
  }

  function handle(event: { type: string; data?: Record<string, unknown> }) {
    const data = event.data ?? {}
    // A reconnect may have happened while a response was streaming. The event
    // stream is live-only, so re-read the active snapshot and the durable
    // transcript instead of waiting for an event that already passed.
    if (event.type === "server.connected") {
      void resume()
      return
    }

    const target = typeof data.sessionID === "string" ? data.sessionID : undefined
    const id = sessionID()
    if (!id || target !== id) return

    if (event.type === "session.status") {
      const status = data.status as { type?: string } | undefined
      // The event vocabulary is idle/busy/retry; the active snapshot uses running.
      const running = status?.type === "busy" || status?.type === "retry" || status?.type === "running"
      setBusy(running)
      if (!running) void refreshSessions()
      return
    }

    if (event.type === "session.next.step.started" || event.type === "session.next.text.started") {
      setBusy(true)
      return
    }

    if (event.type === "session.next.text.delta") {
      const messageID = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      const delta = typeof data.delta === "string" ? data.delta : undefined
      if (messageID && delta) append(messageID, delta)
      return
    }

    if (event.type === "session.next.text.ended") {
      const messageID = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      const text = typeof data.text === "string" ? data.text : undefined
      if (messageID && text !== undefined) setLive((current) => ({ ...current, [messageID]: text }))
      return
    }

    if (event.type === "session.next.step.failed") {
      const failure = data.error as { message?: string } | undefined
      setError(failure?.message || "The response failed.")
      setBusy(false)
      scheduleRefresh(id)
      return
    }

    if (event.type === "session.next.step.ended") {
      setBusy(false)
      scheduleRefresh(id)
      void refreshSessions()
      return
    }

    if (event.type === "session.next.prompted" || event.type === "session.next.prompt.admitted") {
      scheduleRefresh(id)
    }
  }

  function append(messageID: string, delta: string) {
    setLive((current) => ({ ...current, [messageID]: (current[messageID] ?? "") + delta }))
  }

  function scheduleRefresh(id: string) {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => void refresh(id), 60)
  }

  async function refresh(id: string) {
    try {
      const list = await api.messages(id)
      if (sessionID() !== id) return
      setMessages(toRenderedMessages(list))
      // Keep the live map: a delta may have arrived while this fetch was in
      // flight, and clearing it here would drop text that the durable page
      // predates. mergeLive reconciles the two copies.
    } catch {
      // A transient refresh failure leaves the streamed text in place.
    }
  }

  async function refreshSessions() {
    const location = await api.location().catch(() => undefined)
    if (!location) return
    const list = await api.sessions(location.directory).catch(() => undefined)
    if (list) setSessions(list)
  }

  async function resume() {
    const id = sessionID()
    if (!id) return
    const active = await api.active().catch(() => undefined)
    if (active) setBusy(active[id]?.type === "running")
    await refresh(id)
    void refreshSessions()
  }

  async function send() {
    const text = input().trim()
    if (!text || busy()) return
    const model = currentModel()
    if (!model) {
      setError("No chat-compatible models are available on this server.")
      return
    }
    const location = await api.location().catch(() => undefined)
    if (!location) {
      setError("Cannot reach the server.")
      return
    }

    setError(undefined)
    setInput("")
    stick = true
    const firstUserMessage = !messages().some((entry) => entry.role === "user")
    const title = chatTitle(text)
    const localID = `local_${Date.now()}`
    setMessages((current) => [
      ...current,
      { id: localID, role: "user", text, createdAt: Date.now() },
    ])
    setBusy(true)

    try {
      let id = sessionID()
      if (!id) {
        const session = await api.createSession({
          directory: location.directory,
          model: { id: model.id, providerID: model.providerID },
        })
        id = session.id
        setSessionID(id)
        setSessions((current) => [session, ...current])
      }
      await api.prompt(id, text)
      const sessionTitle = currentSession()?.title
      const shouldTitle =
        title && firstUserMessage && (!sessionTitle || sessionTitle.startsWith("New session - "))
      if (shouldTitle) {
        setSessions((current) =>
          current.map((session) => (session.id === id ? { ...session, title } : session)),
        )
        await api.rename(id, title, location.directory).catch(() => undefined)
      }
      scheduleRefresh(id)
      void refreshSessions()
    } catch (err) {
      setMessages((current) => current.filter((entry) => entry.id !== localID))
      setInput(text)
      setBusy(false)
      setError(message(err))
    }
  }

  async function stop() {
    const id = sessionID()
    if (!id) return
    setBusy(false)
    await api.interrupt(id).catch((err) => setError(message(err)))
    scheduleRefresh(id)
  }

  function startNew() {
    setSessionID(undefined)
    setMessages([])
    setLive({})
    setError(undefined)
    setBusy(false)
    setLoading(false)
    setInput("")
    setSidebarOpen(false)
    stick = true
    queueMicrotask(() => textarea?.focus())
  }

  function chooseModel(event: Event) {
    const next = (event.currentTarget as HTMLSelectElement).value
    setModelKey(next)
    localStorage.setItem(MODEL_KEY, next)
    const model = models().find((entry) => key(entry) === next)
    const id = sessionID()
    if (id && model) void api.switchModel(id, { id: model.id, providerID: model.providerID }).catch(() => undefined)
  }

  function grow() {
    if (!textarea) return
    textarea.style.height = "0px"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
  }

  function scrollToBottom() {
    if (!scroller) return
    scroller.scrollTop = scroller.scrollHeight
  }

  function onScroll() {
    if (!scroller) return
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
    event.preventDefault()
    void send()
  }

  function useSuggestion(text: string) {
    setInput(text)
    textarea?.focus()
  }

  return (
    <div class="chat-root">
      <aside classList={{ "chat-sidebar": true, "chat-sidebar-open": sidebarOpen() }}>
        <div class="chat-sidebar-head">
          <span class="chat-wordmark">
            <span class="chat-wordmark-mark">
              <Icon name="models" size="small" />
            </span>
            Omnia
            <span class="chat-wordmark-tag">Chat</span>
          </span>
          <button class="chat-icon chat-sidebar-close" title="Close" onClick={() => setSidebarOpen(false)}>
            <Icon name="close" />
          </button>
        </div>

        <button class="chat-new" onClick={startNew}>
          <Icon name="plus" size="small" />
          New chat
        </button>

        <nav class="chat-history" aria-label="Conversations">
          <Show
            when={sessions().length > 0}
            fallback={<p class="chat-history-empty">Your conversations will appear here.</p>}
          >
            <For each={sessions()}>
              {(session) => (
                <button
                  classList={{ "chat-history-item": true, "chat-history-active": session.id === sessionID() }}
                  onClick={() => void openSession(session.id)}
                >
                  <span class="chat-history-title">{session.title || "New chat"}</span>
                  <span class="chat-history-time">{relative(session.time.updated)}</span>
                </button>
              )}
            </For>
          </Show>
        </nav>

        <div class="chat-sidebar-foot">
          <span classList={{ "chat-status-dot": true, "chat-status-busy": busy() }} />
          <span class="chat-server">{props.baseUrl.replace(/^https?:\/\//, "")}</span>
        </div>
      </aside>

      <Show when={sidebarOpen()}>
        <div class="chat-backdrop" onClick={() => setSidebarOpen(false)} />
      </Show>

      <main class="chat-main">
        <header class="chat-header">
          <button class="chat-icon chat-menu" title="Conversations" onClick={() => setSidebarOpen(true)}>
            <Icon name="menu" />
          </button>
          <div class="chat-heading">
            <span class="chat-title">{title()}</span>
            <span class="chat-subtitle">Chat-only · no tools</span>
          </div>
          <label class="chat-model">
            <Icon name="models" size="small" />
            <select value={modelKey() ?? ""} onChange={chooseModel} aria-label="Model">
              <Show when={models().length > 0} fallback={<option value="">No models</option>}>
                <For each={providerGroups(models())}>
                  {(group) => (
                    <optgroup label={group.provider}>
                      <For each={group.models}>
                        {(model) => <option value={key(model)}>{model.name}</option>}
                      </For>
                    </optgroup>
                  )}
                </For>
              </Show>
            </select>
            <Icon name="chevron-down" size="small" />
          </label>
        </header>

        <Show when={error()}>
          <div class="chat-error" role="alert">
            <Icon name="warning" size="small" />
            <span>{error()}</span>
            <button class="chat-icon" title="Dismiss" onClick={() => setError(undefined)}>
              <Icon name="close" size="small" />
            </button>
          </div>
        </Show>

        <div class="chat-scroll" ref={scroller} onScroll={onScroll}>
          <div class="chat-thread">
            <Show when={!loading()} fallback={<div class="chat-loading">Loading chat…</div>}>
              <Show
                when={rendered().length > 0}
                fallback={
                  <div class="chat-empty">
                    <div class="chat-empty-mark">
                      <Icon name="models" size="large" />
                    </div>
                    <h1>What can I help with?</h1>
                    <p>Ask anything. This space is for conversation, not code changes.</p>
                    <div class="chat-suggestions">
                      <For each={SUGGESTIONS}>
                        {(suggestion) => (
                          <button class="chat-suggestion" onClick={() => useSuggestion(suggestion)}>
                            {suggestion}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                }
              >
                <For each={rendered()}>
                  {(entry) => (
                    <article classList={{ "chat-message": true, [`chat-message-${entry.role}`]: true }}>
                      <Show when={entry.role === "assistant"}>
                        <div class="chat-avatar">
                          <Icon name="models" size="small" />
                        </div>
                      </Show>
                      <div class="chat-bubble">
                        <Show
                          when={entry.role === "assistant"}
                          fallback={<div class="chat-user-text">{entry.text}</div>}
                        >
                          <Show
                            when={entry.text}
                            fallback={
                              <Show when={live()[entry.id] === undefined && busy()}>
                                <div class="chat-thinking">
                                  <span />
                                  <span />
                                  <span />
                                </div>
                              </Show>
                            }
                          >
                            <Markdown
                              class="chat-markdown"
                              text={entry.text}
                              cacheKey={entry.id}
                              streaming={busy() && entry.id === lastAssistantID()}
                            />
                          </Show>
                          <Show when={entry.error}>
                            <div class="chat-message-error">{entry.error}</div>
                          </Show>
                        </Show>
                      </div>
                    </article>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </div>

        <div class="chat-composer-wrap">
          <form
            class="chat-composer"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <textarea
              ref={textarea}
              class="chat-input"
              rows={1}
              value={input()}
              placeholder={busy() ? "Omnia is replying…" : "Message Omnia"}
              onInput={(event) => setInput(event.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
            <Show
              when={busy()}
              fallback={
                <button
                  class="chat-send"
                  type="submit"
                  title="Send"
                  aria-label="Send message"
                  disabled={!input().trim()}
                >
                  <Icon name="arrow-up" />
                </button>
              }
            >
              <button class="chat-send chat-send-stop" type="button" title="Stop" aria-label="Stop response" onClick={() => void stop()}>
                <Icon name="stop" size="small" />
              </button>
            </Show>
          </form>
          <p class="chat-disclaimer">Omnia can make mistakes. Check important information.</p>
        </div>
      </main>
    </div>
  )
}

function key(model: { id: string; providerID: string }) {
  return `${model.providerID}:${model.id}`
}

function providerGroups(models: ChatModel[]) {
  const groups = new Map<string, ChatModel[]>()
  for (const model of models) {
    const provider = model.providerID.replace(/^@/, "")
    groups.set(provider, [...(groups.get(provider) ?? []), model])
  }
  return Array.from(groups, ([provider, list]) => ({ provider, models: list }))
}

function relative(timestamp: number) {
  const delta = Date.now() - timestamp
  if (delta < 60_000) return "now"
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d`
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function message(err: unknown) {
  if (err instanceof ChatApiError) return err.message
  if (err instanceof Error) return err.message
  return "Something went wrong."
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
