// Git operations as one typed tool.
//
// Version control was previously reachable only through the shell, so an agent
// spent turns hand-assembling porcelain plumbing, mis-read machine output, and
// discovered a repository's state by trial and error. These operations return
// parsed, readable results and are the first thing to run when orienting on a
// change.
//
// Mutating operations (add, restore, stash, branch switch) ask first; the
// read-only ones do not, because inspecting a repository is not a side effect.
// There is deliberately no `commit`: committing is the user's decision, and the
// shell stays available if they ask for one.

import { spawn } from "node:child_process"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./git/git.txt"
import * as Tool from "./tool"

const operations = [
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "branch",
  "add",
  "restore",
  "stash",
] as const

const MUTATING = new Set(["add", "restore", "stash", "branch"])
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_OUTPUT = 60_000

export const Parameters = Schema.Struct({
  operation: Schema.Literals(operations).annotate({ description: "The git operation to perform." }),
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Repository-relative paths to limit the operation to.",
  }),
  staged: Schema.optional(Schema.Boolean).annotate({
    description: "For diff and restore: compare or unstage the index against HEAD.",
  }),
  worktree: Schema.optional(Schema.Boolean).annotate({
    description: "For restore: discard edits to the working tree. Destructive.",
  }),
  all: Schema.optional(Schema.Boolean).annotate({ description: "For add: stage every change." }),
  create: Schema.optional(Schema.String).annotate({ description: "For branch: create a branch with this name." }),
  switch: Schema.optional(Schema.String).annotate({ description: "For branch: switch to this branch or commit." }),
  ref: Schema.optional(Schema.String).annotate({ description: "For show: the commit or ref to display." }),
  grep: Schema.optional(Schema.String).annotate({ description: "For log: only commits whose message matches this." }),
  startLine: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "For blame: first line to annotate.",
  }),
  endLine: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "For blame: last line to annotate.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))).annotate({
    description: "For log: how many commits to return. Defaults to 20.",
  }),
  pop: Schema.optional(Schema.Boolean).annotate({ description: "For stash: reapply the stashed changes." }),
})

type Metadata = { readonly operation: string; readonly command: string }

const encode = (value: string) => (/[\s"'\\]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value)

function argsFor(
  operation: (typeof operations)[number],
  params: Schema.Schema.Type<typeof Parameters>,
): string[] {
  const paths = (params.paths ?? []).map(encode)
  if (operation === "status") return ["status", "--porcelain=v2", "--branch"]
  if (operation === "diff")
    return ["diff", ...(params.staged === true ? ["--staged"] : []), ...(params.limit ? [`-U${params.limit}`] : []), ...paths]
  if (operation === "log")
    return [
      "log",
      `--max-count=${params.limit ?? 20}`,
      "--name-status",
      "--no-color",
      ...(params.grep ? [`--grep=${params.grep}`] : []),
      ...paths,
    ]
  if (operation === "show") return ["show", params.ref ?? "HEAD", "--stat", "--patch", "--no-color"]
  if (operation === "blame") {
    const file = paths[0]
    if (file === undefined) return []
    const range = params.startLine === undefined ? [] : [`-L${params.startLine},${params.endLine ?? params.startLine}`]
    return ["blame", "--date=short", ...range, "--", file]
  }
  if (operation === "branch") {
    if (params.create) return ["switch", "--create", params.create]
    if (params.switch) return ["switch", params.switch]
    return ["branch", "--format=%(refname:short)%09%(objectname:short)%09%(upstream:short)%09%(HEAD)"]
  }
  if (operation === "add") return params.all === true ? ["add", "--all"] : ["add", "--", ...paths]
  if (operation === "restore") {
    if (params.staged === true) return ["restore", "--staged", "--", ...paths]
    if (params.worktree === true) return ["restore", "--worktree", "--", ...paths]
    return ["restore", "--", ...paths]
  }
  return params.pop === true ? ["stash", "pop"] : ["stash", "push", "-m", "opencode", ...paths]
}

const run = (command: string[], cwd: string, timeoutMs: number) =>
  new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const child = spawn("git", command, { cwd, windowsHide: true })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ stdout, stderr: `${stderr}\ngit timed out after ${timeoutMs}ms.`, code: 124 })
    }, timeoutMs)
    child.stdout.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr.on("data", (chunk) => (stderr += String(chunk)))
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ stdout, stderr: `${stderr}${error.message}`, code: 127 })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? 0 })
    })
  })

export const GitTool = Tool.define(
  "git",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const command = argsFor(params.operation, params)
          if (command.length === 0) {
            return {
              title: "git",
              output: "blame needs a path. branch takes create, switch, or neither to list branches.",
              metadata: { operation: params.operation, command: "git" },
            }
          }
          const target = params.paths?.[0]
          if (target !== undefined) {
            yield* assertExternalDirectoryEffect(ctx, target, { bypass: false, kind: "file" })
          }
          if (MUTATING.has(params.operation)) {
            yield* ctx.ask({
              permission: "git",
              patterns: [params.operation, ...(params.paths ?? [])],
              always: [params.operation],
              metadata: { operation: params.operation, command: `git ${command.join(" ")}` },
            })
          }
          const result = yield* Effect.promise(() => run(command, instance.worktree, DEFAULT_TIMEOUT_MS))
          const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")
          return {
            title: `git ${params.operation}`,
            output:
              output.length === 0
                ? `git ${params.operation} produced no output.`
                : output.length > MAX_OUTPUT
                  ? `${output.slice(0, MAX_OUTPUT)}\n\n(output truncated at ${MAX_OUTPUT} characters)`
                  : result.code === 0
                    ? output
                    : `${output}\n\ngit exited with code ${result.code}.`,
            metadata: { operation: params.operation, command: `git ${command.join(" ")}` },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
