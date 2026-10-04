import { errorMessage } from "./error"

type Definition = {
  [method: string]: (input: any) => any
}

type Pending = { resolve: (result: any) => void; reject: (error: Error) => void }

// Messages come from a worker boundary, so anything that is not a JSON envelope we understand is
// dropped instead of throwing inside the `message` handler where it would surface as an unhandled
// rejection.
function parse(data: unknown) {
  try {
    const parsed = JSON.parse(String(data))
    return typeof parsed === "object" && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    const parsed = parse(evt.data)
    if (parsed?.type !== "rpc.request") return
    const id = parsed.id
    const handler = typeof parsed.method === "string" ? rpc[parsed.method] : undefined
    // A request that never gets a reply leaves the caller's promise pending forever, so every
    // request path answers exactly once.
    if (!handler) {
      if (id !== undefined)
        postMessage(JSON.stringify({ type: "rpc.error", id, error: `Unknown method: ${parsed.method}` }))
      return
    }
    try {
      const result = await handler(parsed.input)
      postMessage(JSON.stringify({ type: "rpc.result", result, id }))
    } catch (error) {
      postMessage(JSON.stringify({ type: "rpc.error", id, error: errorMessage(error) }))
    }
  }
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
}) {
  const pending = new Map<number, Pending>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  target.onmessage = async (evt) => {
    const parsed = parse(evt.data)
    if (parsed?.type === "rpc.result" || parsed?.type === "rpc.error") {
      const entry = pending.get(parsed.id)
      if (!entry) return
      pending.delete(parsed.id)
      if (parsed.type === "rpc.error") entry.reject(new Error(parsed.error))
      else entry.resolve(parsed.result)
      return
    }
    if (parsed?.type === "rpc.event") {
      const handlers = listeners.get(parsed.event)
      if (!handlers) return
      for (const handler of handlers) {
        handler(parsed.data)
      }
    }
  }
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      return new Promise<ReturnType<T[Method]>>((resolve, reject) => {
        pending.set(requestId, {
          resolve: resolve as (result: any) => void,
          reject,
        })
        try {
          target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
        } catch (error) {
          pending.delete(requestId)
          reject(new Error(`rpc request failed: ${errorMessage(error)}`))
        }
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      const handlers = listeners.get(event) ?? new Set<(data: any) => void>()
      listeners.set(event, handlers)
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
  }
}

export * as Rpc from "./rpc"
