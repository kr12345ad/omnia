export function defer(fn: () => void | Promise<void>): AsyncDisposable & Disposable {
  return {
    [Symbol.dispose]() {
      // nothing can observe an async cleanup here, so keep a rejection from
      // escaping as an unhandled promise rejection
      void Promise.resolve(fn()).catch(() => {})
    },
    [Symbol.asyncDispose]() {
      return Promise.resolve(fn())
    },
  }
}
