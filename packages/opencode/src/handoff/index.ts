export * as Handoff from "./index"

export { run } from "./run"

import { SessionV1 } from "@opencode-ai/core/v1/session"
import { HandoffDormant, matches, scan, type DormantAgent } from "./dormant"
import { HandoffPacket, type Packet } from "./packet"
import { HandoffTrigger, isTestCommand, packet as createPacket, tokensFromMessages } from "./trigger"

export { HandoffDormant, HandoffPacket, HandoffTrigger }
export type { DormantAgent, Packet }

export type Prepared = {
  root: string
  packet: Packet
  matches: DormantAgent[]
  logText: string
  logPath: string
}

export type SessionRef = {
  id: string
  parentID?: string
  agent?: string
  directory: string
  metadata?: Record<string, unknown>
}

type ToolResult = {
  output: string
  metadata: Record<string, unknown>
}

/**
 * Runs after a shell tool result. Side effects only happen when a configured
 * dormant agent claims the trigger, so projects without `.omnia/agents` never
 * grow a `.omnia` directory just because a test failed.
 */
export async function prepare(input: {
  root: string
  session: SessionRef
  tool: string
  args: Record<string, unknown>
  result: ToolResult
  messages: SessionV1.WithParts[]
}): Promise<Prepared | undefined> {
  if (input.tool !== "bash") return undefined
  // Handoff-spawned children carry metadata.handoff. That marker, not the
  // presence of a parent, is the recursion boundary: regular task subagents
  // may escalate their own failing tests, but a specialist cannot wake another
  // specialist.
  if (input.session.metadata?.handoff) return undefined
  const command = typeof input.args.command === "string" ? input.args.command : ""
  if (command.length === 0 || !isTestCommand(command)) return undefined
  const exitCode = typeof input.result.metadata.exit === "number" ? input.result.metadata.exit : null
  if (exitCode === null || exitCode === 0) return undefined

  const agents = await scan(input.root)
  const matched = agents.filter((agent) => matches(agent, { kind: "test-failure", command }))
  if (matched.length === 0) return undefined

  const output = await resultText(input.result)
  const log = await HandoffPacket.writeLog(input.root, input.session.id, renderLog(command, input, output, exitCode))
  const value = createPacket({
    sessionID: input.session.id,
    parentSessionID: input.session.parentID,
    agent: input.session.agent,
    trigger: {
      kind: "test-failure",
      command,
      pattern: HandoffTrigger.TEST_COMMAND.source,
    },
    command: {
      text: command,
      shell: typeof input.args.shell === "string" ? input.args.shell : "bash",
      cwd: typeof input.args.workdir === "string" ? input.args.workdir : input.session.directory,
      exitCode,
      ...(typeof input.args.timeout === "number" ? { timeout: input.args.timeout } : {}),
    },
    git: HandoffPacket.collectGit(input.root),
    tokens: tokensFromMessages(input.messages),
    targets: [...new Set(matched.flatMap((agent) => agent.targets))],
    log,
    next: matched.map((agent) => agent.name),
  })
  const written = await HandoffPacket.write(input.root, value)
  return {
    root: input.root,
    packet: written,
    matches: matched,
    logText: output,
    logPath: HandoffPacket.logPath(input.root, input.session.id),
  }
}

export async function prepareManual(input: {
  root: string
  session: SessionRef
  agent: DormantAgent
  reason: string
  messages: SessionV1.WithParts[]
}): Promise<Prepared> {
  const value = createPacket({
    sessionID: input.session.id,
    parentSessionID: input.session.parentID,
    agent: input.agent.name,
    trigger: { kind: "manual", command: input.reason },
    command: {
      text: input.reason,
      shell: "manual",
      cwd: input.session.directory,
      exitCode: null,
    },
    git: HandoffPacket.collectGit(input.root),
    tokens: tokensFromMessages(input.messages),
    targets: input.agent.targets,
    next: [input.agent.name],
  })
  const written = await HandoffPacket.write(input.root, value)
  return {
    root: input.root,
    packet: written,
    matches: [input.agent],
    logText: "",
    logPath: HandoffPacket.logPath(input.root, input.session.id),
  }
}

export async function body(agent: DormantAgent) {
  return HandoffDormant.prompt(agent)
}

export async function mark(
  prepared: Prepared,
  update: Pick<Packet, "status"> & {
    taskID?: string
    agent?: string
    summary?: string
    error?: string
  },
) {
  const current = (await HandoffPacket.read(prepared.root, prepared.packet.sessionID)) ?? prepared.packet
  return HandoffPacket.write(prepared.root, {
    ...current,
    ...update,
    updatedAt: new Date().toISOString(),
  })
}

async function resultText(result: ToolResult) {
  const outputPath = result.metadata.outputPath
  if (typeof outputPath !== "string") return result.output
  const full = await Bun.file(outputPath)
    .text()
    .catch(() => undefined)
  return full ?? result.output
}

function renderLog(
  command: string,
  input: { root: string; session: SessionRef },
  output: string,
  exitCode: number,
) {
  return [
    `$ ${command}`,
    `cwd: ${input.session.directory}`,
    `workspace: ${input.root}`,
    `exit: ${exitCode}`,
    `time: ${new Date().toISOString()}`,
    "",
    output,
  ].join("\n")
}
