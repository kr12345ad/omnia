import { describe, expect, test } from "bun:test"
import { ImmutableEventEmitter } from "./events"

describe("immutable event emission", () => {
  test("clones nested payloads and freezes emitted events", () => {
    const emitter = new ImmutableEventEmitter<{ readonly id: string; readonly data: { readonly value: number } }>()
    const source = { id: "event-1", data: { value: 1 } }
    const emitted = emitter.emit(source)
    source.data.value = 2
    expect(emitted.data.value).toBe(1)
    expect(Object.isFrozen(emitted)).toBe(true)
    expect(Object.isFrozen(emitted.data)).toBe(true)
    expect(Object.isFrozen(emitter.history())).toBe(true)
  })

  test("supports unsubscribe and one-shot listeners", () => {
    const emitter = new ImmutableEventEmitter<{ readonly value: number }>()
    const seen: number[] = []
    const unsubscribe = emitter.subscribe((event) => seen.push(event.value))
    emitter.once((event) => seen.push(event.value * 10))
    emitter.emit({ value: 1 })
    emitter.emit({ value: 2 })
    unsubscribe()
    emitter.emit({ value: 3 })
    expect(seen).toEqual([1, 10, 2])
  })
})
