import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { SpecialistStore, defaultSpecialistsFile } from "./store.js"

const dirs: string[] = []

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "omnia-specialists-"))
  dirs.push(dir)
  return dir
}

function store() {
  const dir = temp()
  const file = join(dir, "specialists.json")
  return { dir, file, store: new SpecialistStore({ file }) }
}

const roster = [
  { name: "Designer", focus: "Layout and typography." },
  { role: "counsel", name: "Lawyer", focus: "Contracts and liability." },
]

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("SpecialistStore", () => {
  test("defaults to specialists.json next to the memory store", () => {
    expect(defaultSpecialistsFile()).toBe(join(homedir(), ".local", "share", "omnia", "specialists.json"))
    expect(new SpecialistStore().path).toBe(defaultSpecialistsFile())
  })

  test("load is undefined when nothing was saved", () => {
    expect(store().store.load()).toBeUndefined()
  })

  test("round trips a normalized roster, also through a new instance", () => {
    const { store: first, file } = store()
    const saved = first.save(roster)
    expect(saved).toEqual({
      ok: true,
      specialists: [
        { role: "designer", name: "Designer", focus: "Layout and typography." },
        { role: "counsel", name: "Lawyer", focus: "Contracts and liability." },
      ],
    })
    if (!saved.ok) return
    expect(first.load()).toEqual(saved.specialists)
    expect(new SpecialistStore({ file }).load()).toEqual(saved.specialists)
  })

  test("save overwrites the previous roster", () => {
    const { store: target } = store()
    target.save(roster)
    target.save([
      { name: "Ada", focus: "One." },
      { name: "Bob", focus: "Two." },
      { name: "Cy", focus: "Three." },
    ])
    expect(target.load()?.map((item) => item.role)).toEqual(["ada", "bob", "cy"])
  })

  test("writes the file with mode 0600 and leaves no temp files", () => {
    const { store: target, file, dir } = store()
    target.save(roster)
    expect(lstatSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(["specialists.json"])
  })

  test("tightens the mode of an older, looser file", () => {
    const { store: target, file } = store()
    writeFileSync(file, "{}", { mode: 0o644 })
    target.save(roster)
    expect(lstatSync(file).mode & 0o777).toBe(0o600)
  })

  test("creates missing parent directories", () => {
    const dir = temp()
    const file = join(dir, "a", "b", "specialists.json")
    const target = new SpecialistStore({ file })
    expect(target.save(roster).ok).toBe(true)
    expect(target.load()).toHaveLength(2)
  })

  test("an invalid roster is rejected and leaves the saved one untouched", () => {
    const { store: target, file } = store()
    target.save(roster)
    const before = readFileSync(file, "utf8")
    const result = target.save([{ name: "Solo", focus: "Alone." }])
    expect(result.ok).toBe(false)
    expect(target.save("nope").ok).toBe(false)
    expect(readFileSync(file, "utf8")).toBe(before)
    expect(target.load()).toHaveLength(2)
  })

  test("an invalid roster never creates a file", () => {
    const { store: target, file } = store()
    const result = target.save([{ name: "Manager", focus: "Runs it." }, ...roster])
    expect(result).toEqual({ ok: false, error: `Manager's role "manager" is reserved.` })
    expect(existsSync(file)).toBe(false)
  })

  test("refuses to save through a symlink and leaves its target alone", () => {
    const { dir, file, store: target } = store()
    const victim = join(dir, "victim.txt")
    writeFileSync(victim, "precious")
    symlinkSync(victim, file)
    const result = target.save(roster)
    expect(result.ok).toBe(false)
    expect(readFileSync(victim, "utf8")).toBe("precious")
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(["specialists.json", "victim.txt"])
  })

  test("refuses a dangling symlink", () => {
    const { dir, file, store: target } = store()
    symlinkSync(join(dir, "missing.txt"), file)
    expect(target.save(roster).ok).toBe(false)
    expect(existsSync(join(dir, "missing.txt"))).toBe(false)
  })

  test("does not read a roster through a symlink", () => {
    const { dir, file, store: target } = store()
    const real = join(dir, "real.json")
    new SpecialistStore({ file: real }).save(roster)
    symlinkSync(real, file)
    expect(target.load()).toBeUndefined()
  })

  test("refuses to replace a directory", () => {
    const { file, store: target } = store()
    mkdirSync(file)
    expect(target.save(roster).ok).toBe(false)
    expect(target.load()).toBeUndefined()
  })

  test("a corrupt file is treated as none saved, and can be saved over", () => {
    const { file, store: target } = store()
    for (const content of ["", "{", "not json", "null", "[]", "42", '"x"', "{}", '{"specialists":"x"}']) {
      writeFileSync(file, content)
      expect(target.load()).toBeUndefined()
    }
    writeFileSync(file, "{ torn")
    expect(target.save(roster).ok).toBe(true)
    expect(target.load()).toHaveLength(2)
  })

  test("a file that parses but holds an invalid roster is treated as none saved", () => {
    const { file, store: target } = store()
    const bad = [
      [{ role: "manager", name: "Boss", focus: "f" }, ...roster],
      [roster[0]],
      [{ name: "A", focus: "f" }, { name: "A", focus: "g" }],
      Array.from({ length: 7 }, (_, index) => ({ name: `R${index}`, focus: "f" })),
    ]
    for (const specialists of bad) {
      writeFileSync(file, JSON.stringify({ version: 1, specialists }))
      expect(target.load()).toBeUndefined()
    }
  })

  test("an unreadable file is treated as none saved", () => {
    if (process.getuid?.() === 0) return
    const { file, store: target } = store()
    target.save(roster)
    chmodSync(file, 0o000)
    expect(target.load()).toBeUndefined()
  })

  test("load re-validates, so a hand-edited file is normalized", () => {
    const { file, store: target } = store()
    writeFileSync(file, JSON.stringify({ version: 1, specialists: [{ name: "  Ada\u0000 ", focus: " f " }, roster[1]] }))
    expect(target.load()?.[0]).toEqual({ role: "ada", name: "Ada", focus: "f" })
  })

  test("reset removes the file and load reports none saved", () => {
    const { file, store: target } = store()
    target.save(roster)
    target.reset()
    expect(existsSync(file)).toBe(false)
    expect(target.load()).toBeUndefined()
  })

  test("reset is a no-op when nothing was saved", () => {
    const { store: target } = store()
    expect(() => target.reset()).not.toThrow()
    expect(() => target.reset()).not.toThrow()
  })

  test("reset removes a corrupt file", () => {
    const { file, store: target } = store()
    writeFileSync(file, "{ torn")
    target.reset()
    expect(existsSync(file)).toBe(false)
  })

  test("reset removes a symlink without touching its target", () => {
    const { dir, file, store: target } = store()
    const victim = join(dir, "victim.txt")
    writeFileSync(victim, "precious")
    symlinkSync(victim, file)
    target.reset()
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(victim, "utf8")).toBe("precious")
  })

  test("save after reset works", () => {
    const { store: target } = store()
    target.save(roster)
    target.reset()
    expect(target.save(roster).ok).toBe(true)
    expect(target.load()).toHaveLength(2)
  })
})
