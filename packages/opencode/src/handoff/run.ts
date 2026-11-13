export * as HandoffRun from "./run"

import { Cause, Effect } from "effect"
import type { Agent } from "@/agent/agent"
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import type { TaskPromptOps } from "@/tool/task"
import { prompt as dormantPrompt, type DormantAgent } from "./dormant"
import { appendInbox, logPath, read, write, type Packet } from "./packet"
import type { Prepared } from "./index"
import { delivered, hydratePrompt, logTail } from "./trigger"

/**
 * Hydrate one dormant agent in a child session, then push its summary back to
 * the parent as a synthetic user message. The child is a real session, so its
 * transcript, token usage and cancellation behavior stay inspectable.
 */
export function run(input: {
  prepared: Prepared
  agent: DormantAgent
  parent: { id: SessionID; agent?: string }
  ops: TaskPromptOps
  sessions: Session.Interface
  agents: Agent.Interface
  deliver?: boolean
}) {
  const notify = (packet: Packet) =>
    Effect.gen(function* () {
      if (input.deliver === false) return
      const message = delivered(input.agent, packet)
      yield* Effect.promise(() =>
        appendInbox(input.prepared.root, input.prepared.packet.sessionID, {
          role: "agent",
          sessionID: packet.taskID ?? input.prepared.packet.sessionID,
          text: message,
        }),
      )
      yield* input.ops
        .prompt({
          sessionID: input.parent.id,
          agent: input.parent.agent ?? "build",
          parts: [{ type: "text", text: message, synthetic: true }],
        })
        .pipe(Effect.ignore)
    }).pipe(Effect.ignore)

  const work = Effect.gen(function* () {
    const reviewer = yield* input.agents
      .get(input.agent.agent)
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!reviewer) {
      const failed = yield* Effect.promise(() =>
        mark(input.prepared, {
          status: "failed",
          error: `Dormant agent requested unknown agent type: ${input.agent.agent}`,
        }),
      )
      yield* notify(failed)
      return
    }

    const child = yield* input.sessions.create({
      parentID: input.parent.id,
      title: `${input.agent.name}: ${input.prepared.packet.command?.text ?? "handoff"}`.slice(0, 120),
      agent: input.agent.agent,
      metadata: { handoff: { packet: input.prepared.packet.id, parent: input.parent.id } },
    })
    const running = yield* Effect.promise(() =>
      mark(input.prepared, { status: "running", taskID: child.id, agent: input.agent.name }),
    )
    const body = yield* Effect.promise(() => dormantPrompt(input.agent))
    const prompt = hydratePrompt({
      agent: input.agent,
      root: input.prepared.root,
      sessionID: input.prepared.packet.sessionID,
      body,
      packet: running,
      logTail: logTail(input.prepared.logText),
      logPath: logPath(input.prepared.root, input.prepared.packet.sessionID),
    })

    const result = yield* input.ops.prompt({
      sessionID: child.id,
      agent: input.agent.agent,
      parts: [{ type: "text", text: prompt }],
    })
    const summary = result.parts.findLast((part) => part.type === "text")?.text?.trim() ?? ""
    const finished = yield* Effect.promise(() =>
      mark(input.prepared, {
        status: summary.length > 0 ? "completed" : "failed",
        summary,
        ...(summary.length > 0 ? {} : { error: "The dormant agent returned no text." }),
      }),
    )
    yield* notify(finished)
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const failed = yield* Effect.promise(() =>
          mark(input.prepared, { status: "failed", error: Cause.pretty(cause) }),
        )
        yield* notify(failed)
      }).pipe(Effect.ignore),
    ),
  )

  return work
}

async function mark(
  prepared: Prepared,
  update: Pick<Packet, "status"> & {
    taskID?: string
    agent?: string
    summary?: string
    error?: string
  },
) {
  // Re-read before every transition so taskID/agent written by the running
  // transition survive into the completed/failed packet.
  const current = (await read(prepared.root, prepared.packet.sessionID)) ?? prepared.packet
  return write(prepared.root, {
    ...current,
    ...update,
    updatedAt: new Date().toISOString(),
  })
}
