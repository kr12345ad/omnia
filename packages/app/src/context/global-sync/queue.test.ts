import { describe, expect, test } from "bun:test"
import { createRefreshQueue } from "./queue"
import { directoryKey } from "./utils"

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("createRefreshQueue", () => {
  test("clears queued directories by normalized key", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("C:\\tmp\\demo")
    queue.clear("C:/tmp/demo")

    await tick()

    expect(calls).toEqual([])
    queue.dispose()
  })

  test("passes the original directory to bootstrapInstance", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("C:\\tmp\\demo")

    await tick()

    expect(calls).toEqual(["C:\\tmp\\demo"])
    queue.dispose()
  })
})

test("disposal stops a suspended refresh and rejects further queued work", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const calls: string[] = []
  const queue = createRefreshQueue({ paused: () => false, bootstrap: () => gate, bootstrapInstance: (dir) => { calls.push(dir) } })
  queue.refresh()
  await tick()
  queue.push("before")
  queue.dispose()
  queue.push("after")
  queue.refresh()
  release()
  await tick()
  expect(calls).toEqual([])
})
