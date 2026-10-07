import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "@/config/config"
import { ConfigPaths } from "@/config/paths"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { HttpClient } from "effect/unstable/http"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AuthTest } from "../fake/auth"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const previous = process.env.OMNIA_CONFIG_FILE
const originalConfig = Global.Path.config
afterEach(() => {
  if (previous === undefined) delete process.env.OMNIA_CONFIG_FILE
  else process.env.OMNIA_CONFIG_FILE = previous
  Global.Path.config = originalConfig
})
const it = testEffect(
  LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
    ],
  ]),
)
const write = (file: string, value: object) =>
  fs.writeFile(file, JSON.stringify({ $schema: "https://opencode.ai/config.json", ...value }))

it.instance("Omnia global/project read and write use OMNIA.json and leave compatibility files intact", () =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const ctx = yield* TestInstance
    const global = yield* tmpdirScoped()
    Global.Path.config = global
    const omnia = path.join(global, "app", "config", "OMNIA.json")
    process.env.OMNIA_CONFIG_FILE = omnia
    yield* Effect.promise(() =>
      write(path.join(global, "opencode.json"), { username: "standalone", model: "cli/model" }),
    )
    yield* Effect.promise(() =>
      fs.writeFile(path.join(ctx.directory, "opencode.json"), JSON.stringify({ username: "compatible-project" })),
    )
    const upstreamBefore = yield* Effect.promise(() => fs.readFile(path.join(global, "opencode.json"), "utf8"))
    const projectBefore = yield* Effect.promise(() => fs.readFile(path.join(ctx.directory, "opencode.json"), "utf8"))
    expect(yield* config.getGlobal()).not.toHaveProperty("model")
    yield* config.updateGlobal({ username: "omnia-global", model: "omnia/model" })
    expect((yield* config.getGlobal()).username).toBe("omnia-global")
    yield* config.update({ username: "omnia-project" })
    expect((yield* config.get()).username).toBe("omnia-project")
    expect((yield* config.get()).model).toBe("omnia/model")
    const saved = yield* Effect.promise(() => fs.readFile(omnia, "utf8"))
    expect(JSON.parse(saved).username).toBe("omnia-global")
    expect((yield* Effect.promise(() => fs.stat(omnia))).mode & 0o777).toBe(0o600)
    expect((yield* Effect.promise(() => fs.stat(path.join(ctx.directory, "OMNIA.json")))).mode & 0o777).toBe(0o600)
    expect(yield* Effect.promise(() => fs.readFile(path.join(global, "opencode.json"), "utf8"))).toBe(upstreamBefore)
    expect(yield* Effect.promise(() => fs.readFile(path.join(ctx.directory, "opencode.json"), "utf8"))).toBe(
      projectBefore,
    )
    expect(
      yield* Effect.promise(() =>
        fs.access(path.join(ctx.directory, "config.json")).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false)
  }),
)

it.instance("standalone CLI config defaults remain unchanged without the Omnia signal", () =>
  Effect.gen(function* () {
    delete process.env.OMNIA_CONFIG_FILE
    const config = yield* Config.Service
    const ctx = yield* TestInstance
    const global = yield* tmpdirScoped()
    Global.Path.config = global
    yield* Effect.promise(() => write(path.join(global, "opencode.json"), { username: "standalone" }))
    yield* Effect.promise(() => write(path.join(ctx.directory, "OMNIA.json"), { username: "ignored" }))
    expect((yield* config.getGlobal()).username).toBe("standalone")
    yield* config.updateGlobal({ username: "cli-update" })
    yield* config.update({ username: "cli-project" })
    expect(
      JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(global, "opencode.json"), "utf8"))).username,
    ).toBe("cli-update")
    expect(
      JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(ctx.directory, "config.json"), "utf8"))).username,
    ).toBe("cli-project")
    expect((yield* config.get()).username).toBe("cli-update")
  }),
)

it.live("Omnia config writer refuses symlinks and leaves the target intact", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const target = path.join(tmp, "target.json")
    const link = path.join(tmp, "OMNIA.json")
    yield* Effect.promise(() => fs.writeFile(target, "original"))
    yield* Effect.promise(() => fs.symlink(target, link))
    const result = yield* Effect.promise(() => ConfigPaths.writeOmniaConfig(link, "changed")).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("original")
  }),
)
