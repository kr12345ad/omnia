import {
  createContext,
  createSignal,
  onMount,
  useContext,
  type ParentProps,
} from "solid-js"
import { api, isUnauthenticated } from "@/lib/api"
import { navigate } from "@/lib/router"
import type { Capability, SessionPayload } from "@/types"

interface SessionState {
  session: () => SessionPayload | null
  loading: () => boolean
  error: () => string | undefined
  refresh: () => Promise<SessionPayload | null>
  adopt: (session: SessionPayload) => void
  signOut: () => Promise<void>
  can: (capability: Capability) => boolean
}

const SessionContext = createContext<SessionState>()

export function SessionProvider(props: ParentProps) {
  const [session, setSession] = createSignal<SessionPayload | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()

  const refresh = async () => {
    setLoading(true)
    try {
      const next = await api.session()
      setSession(next)
      setError(undefined)
      return next
    } catch (cause) {
      if (!isUnauthenticated(cause)) setError(cause instanceof Error ? cause.message : String(cause))
      setSession(null)
      return null
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void refresh()
  })

  const value: SessionState = {
    session,
    loading,
    error,
    refresh,
    adopt: (next) => {
      setSession(next)
      setError(undefined)
      setLoading(false)
    },
    signOut: async () => {
      await api.logout().catch(() => undefined)
      setSession(null)
      navigate("/login")
    },
    can: (capability) => session()?.capabilities.includes(capability) === true,
  }

  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>
}

export function useSession(): SessionState {
  const context = useContext(SessionContext)
  if (context === undefined) throw new Error("useSession must be used inside SessionProvider")
  return context
}

// ── Toasts ─────────────────────────────────────────────────────────────────

interface Toast {
  id: number
  message: string
  tone: "success" | "error" | "info"
}

interface ToastState {
  toasts: () => Toast[]
  push: (message: string, tone?: Toast["tone"]) => void
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastState>()

export function ToastProvider(props: ParentProps) {
  const [toasts, setToasts] = createSignal<Toast[]>([])
  let next = 1
  const dismiss = (id: number) => setToasts((list) => list.filter((toast) => toast.id !== id))
  const push = (message: string, tone: Toast["tone"] = "info") => {
    const id = next++
    setToasts((list) => [...list.slice(-3), { id, message, tone }])
    window.setTimeout(() => dismiss(id), tone === "error" ? 8_000 : 4_500)
  }
  return (
    <ToastContext.Provider value={{ toasts, push, dismiss }}>
      {props.children}
      <div class="ent-toasts" aria-live="polite">
        {toasts().map((toast) => (
          <button
            type="button"
            class="ent-toast"
            data-tone={toast.tone}
            onClick={() => dismiss(toast.id)}
            title="Dismiss"
          >
            <span class="ent-toast-dot" />
            <span>{toast.message}</span>
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastState {
  const context = useContext(ToastContext)
  if (context === undefined) throw new Error("useToast must be used inside ToastProvider")
  return context
}

