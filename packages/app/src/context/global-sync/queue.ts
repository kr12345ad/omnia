type QueueInput = {
  paused: () => boolean
  bootstrap: () => Promise<void>
  bootstrapInstance: (directory: string) => Promise<void> | void
  key?: (directory: string) => string
}

export function createRefreshQueue(input: QueueInput) {
  const queued = new Map<string, string>()
  let root = false
  let running = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const key = input.key ?? ((directory: string) => directory)

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  const take = (count: number) => {
    if (queued.size === 0) return [] as string[]
    const items: string[] = []
    for (const [id, directory] of queued) {
      queued.delete(id)
      items.push(directory)
      if (items.length >= count) break
    }
    return items
  }

  const schedule = () => {
    if (disposed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void drain()
    }, 0)
  }

  const push = (directory: string) => {
    if (disposed || !directory) return
    queued.set(key(directory), directory)
    if (disposed || input.paused()) return
    schedule()
  }

  const refresh = () => {
    if (disposed) return
    root = true
    if (disposed || input.paused()) return
    schedule()
  }

  async function drain() {
    if (disposed || running) return
    running = true
    try {
      while (true) {
        if (disposed || input.paused()) return
        if (root) {
          root = false
          await input.bootstrap()
          await tick()
          continue
        }
        const dirs = take(2)
        if (dirs.length === 0) return
        await Promise.all(dirs.map((dir) => input.bootstrapInstance(dir)))
        await tick()
      }
    } finally {
      running = false
      // oxlint-disable-next-line no-unsafe-finally -- intentional: early return skips schedule() when paused
      if (disposed || input.paused()) return
      if (root || queued.size) schedule()
    }
  }

  return {
    push,
    refresh,
    clear(directory: string) {
      queued.delete(key(directory))
    },
    dispose() {
      disposed = true
      root = false
      queued.clear()
      if (!timer) return
      clearTimeout(timer)
      timer = undefined
    },
  }
}
