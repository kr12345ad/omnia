export * as HandoffTrigger from "./trigger"

import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { DormantAgent } from "./dormant"
import type { Git, Packet, Tokens, Trigger } from "./packet"

// Package-manager and runner forms only. A bare "test" argument (for example
// `git commit -m test`) must not wake an agent and start a paid model turn.
export const TEST_COMMAND =
  /(?:^|[\s;&|()])(?:(?:bun|npm|pnpm|yarn|npx|bunx|deno)\s+(?:run\s+)?test\b|(?:pytest|py\.test|vitest|jest|mocha|ava|rspec|phpunit|ctest|playwright|cypress)\b|(?:cargo|go|dotnet|swift|mvn|gradle|make)\s+test\b|node\s+--test\b)/i

export function isTestCommand(command: string) {
  return TEST_COMMAND.test(command)
}

export function tokensFromMessages(messages: SessionV1.WithParts[]): Tokens | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const info = messages[index]?.info
    if (info?.role !== "assistant") continue
    const value = info.tokens
    return {
      input: value.input,
      output: value.output,
      reasoning: value.reasoning,
      cacheRead: value.cache.read,
      cacheWrite: value.cache.write,
      total: value.total ?? value.input + value.output + value.reasoning + value.cache.read + value.cache.write,
    }
  }
  return undefined
}

export function packet(input: {
  sessionID: string
  parentSessionID?: string
  agent?: string
  trigger: Trigger
  command?: Packet["command"]
  git?: Git
  tokens?: Tokens
  targets: string[]
  log?: string
  next: string[]
}): Packet {
  const at = new Date().toISOString()
  return {
    version: 1,
    id: crypto.randomUUID(),
    sessionID: input.sessionID,
    parentSessionID: input.parentSessionID,
    agent: input.agent,
    status: "running",
    createdAt: at,
    updatedAt: at,
    trigger: input.trigger,
    command: input.command,
    git: input.git,
    tokens: input.tokens,
    targets: input.targets,
    log: input.log,
    next: input.next,
    messages: [
      {
        at,
        role: "supervisor",
        text:
          input.trigger.kind === "test-failure"
            ? `Test command failed: ${input.command?.text ?? "unknown command"}`
            : `Manual handoff: ${input.command?.text ?? "no reason supplied"}`,
      },
    ],
  }
}

/**
 * The stable prefix is deliberately first and free of timestamps, branch name,
 * command and packet id. Providers cache the longest matching prefix, so the
 * expensive parts (role contract and workspace facts) are reused across every
 * failure while only the packet and log tail are new tokens.
 */
export function staticContext(agent: DormantAgent, root: string, sessionID: string, body: string) {
  return [
    "# Omnia dormant handoff",
    "",
    "You are a dormant sub-agent, hydrated for one diagnostic turn by the Omnia handoff supervisor.",
    "You are not the main agent and you cannot see its conversation. Work only from the packet and the captured log.",
    "",
    "## Role contract",
    body.trim().length > 0
      ? body.trim()
      : [
          "You are a failure analyst. Read the captured output, identify the first real failure,",
          "and return a short, actionable diagnosis. Do not edit files.",
        ].join("\n"),
    "",
    "## Stable workspace context",
    `- Workspace root: ${root}`,
    `- Handoff session: ${sessionID}`,
    `- Dormant agent: ${agent.name}`,
    `- Hydrated as: ${agent.agent}`,
    `- Captured output file: last_test_run.log`,
    "",
    "## Output contract",
    "Return plain text with these sections, no preamble:",
    "1. Failure: the exact assertion or error, with file and line when present.",
    "2. Cause: the smallest explanation that fits the evidence.",
    "3. Fix: a concrete change, including the file to touch.",
    "4. Confidence: high, medium, or low, plus what would raise it.",
    "",
    "Keep the whole reply under 250 words. Never invent output that is not in the log.",
  ].join("\n")
}

export function dynamicContext(input: {
  packet: Packet
  logTail: string
  logPath: string
}) {
  const value = input.packet
  const git = value.git
  const command = value.command
  const tokens = value.tokens
  const packetView = {
    id: value.id,
    sessionID: value.sessionID,
    parentSessionID: value.parentSessionID,
    taskID: value.taskID,
    status: value.status,
    createdAt: value.createdAt,
    trigger: value.trigger,
    targets: value.targets,
    next: value.next,
  }
  return [
    "## Dynamic packet",
    "```json",
    JSON.stringify(packetView, null, 2),
    "```",
    "",
    "## Command",
    command
      ? [
          "```text",
          `$ ${command.text}`,
          `shell: ${command.shell}`,
          `cwd: ${command.cwd}`,
          `exit: ${command.exitCode ?? "unknown"}`,
          "```",
        ].join("\n")
      : "No command was recorded.",
    "",
    "## Repository",
    git
      ? [
          `- Branch: ${git.branch ?? "detached"}`,
          `- HEAD: ${git.head ?? "unknown"}`,
          `- Dirty: ${git.dirty ? "yes" : "no"}`,
          ...(git.files.length > 0 ? ["- Changed files:", ...git.files.map((file) => `  - ${file}`)] : []),
        ].join("\n")
      : "Git metadata unavailable.",
    "",
    ...(tokens
      ? [
          "## Token tally",
          `input=${tokens.input} output=${tokens.output} reasoning=${tokens.reasoning} cache_read=${tokens.cacheRead} cache_write=${tokens.cacheWrite} total=${tokens.total}`,
          "",
        ]
      : []),
    "## Captured output",
    `Full file: ${input.logPath}`,
    "```text",
    input.logTail,
    "```",
  ].join("\n")
}

export function hydratePrompt(input: {
  agent: DormantAgent
  root: string
  sessionID: string
  body: string
  packet: Packet
  logTail: string
  logPath: string
}) {
  return [
    staticContext(input.agent, input.root, input.sessionID, input.body),
    "",
    dynamicContext({ packet: input.packet, logTail: input.logTail, logPath: input.logPath }),
  ].join("\n")
}

export function delivered(agent: DormantAgent, packet: Packet) {
  const summary = packet.summary?.trim() || packet.error || "The dormant agent returned no text."
  return [
    `<handoff_result agent="${agent.name}" status="${packet.status}" task="${packet.taskID ?? ""}" packet="${packet.id}">`,
    summary,
    "</handoff_result>",
    "",
    `Full packet: .omnia/sessions/${packet.sessionID}/handoff.json`,
    `Captured output: .omnia/sessions/${packet.sessionID}/last_test_run.log`,
  ].join("\n")
}

export function envelope(input: {
  from: string
  agent?: string
  message: string
}) {
  return [
    `<handoff_message from="session:${input.from}"${input.agent ? ` agent="${input.agent}"` : ""}>`,
    input.message,
    "</handoff_message>",
  ].join("\n")
}

export function logTail(text: string, limit = 60_000) {
  if (text.length <= limit) return text
  return `...[earlier output truncated; read the full log file]...\n${text.slice(text.length - limit)}`
}
