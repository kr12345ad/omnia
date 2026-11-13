import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Tool } from "./tool"
import type { TaskPromptOps } from "./task"
import { Handoff, HandoffTrigger } from "@/handoff"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"

export const Parameters = Schema.Struct({
  sessionID: Schema.optional(Schema.String).annotate({
    description: "Target session id. Defaults to the calling session's parent.",
  }),
  message: Schema.String.annotate({
    description: "The message to place in the target session's stream.",
  }),
  agent: Schema.optional(Schema.String).annotate({
    description: "Agent name the target session should answer with. Defaults to the target's agent.",
  }),
})

/**
 * Resolve the delivery target before any filesystem or prompt work. The
 * default is the immediate parent, which is how a subagent reports upward; an
 * explicit session id lets the root address a specific child. Self-delivery is
 * refused because it would inject the sender's own message into the turn it is
 * already running.
 */
export function resolveSendMessageTarget(input: {
  requested?: string
  caller: SessionID
  parentID?: SessionID
}): { ok: true; id: SessionID } | { ok: false; error: string } {
  const id = input.requested ? SessionID.make(input.requested) : input.parentID
  if (!id) {
    return { ok: false, error: "This session has no parent. Pass sessionID explicitly to choose a target." }
  }
  if (id === input.caller) {
    return { ok: false, error: "Refusing to send a message into the calling session" }
  }
  return { ok: true, id }
}

/**
 * Cross-session delivery. The actual prompt is forked so the sender returns
 * immediately; the target's normal event stream (message.updated and
 * message.part.updated) is what makes the message appear in its terminal UI.
 */
export const SendMessageTool = Tool.define(
  "send_message",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    return {
      description: [
        "Push a message into another Omnia session's message stream without blocking the caller.",
        "Use this to report a dormant agent's result to the main session, or to wake a parent task.",
        "The message is delivered as a synthetic user message and starts a normal turn in the target session.",
        "Omit sessionID to target the calling session's parent. Sending to the calling session itself is refused.",
        "The message is written to the target's inbox before its wake is scheduled, so a failed wake never loses it.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!ops) return yield* Effect.fail(new Error("send_message requires an active session runtime"))

          const current = yield* sessions.get(ctx.sessionID)
          const resolved = resolveSendMessageTarget({
            requested: params.sessionID,
            caller: ctx.sessionID,
            parentID: current.parentID,
          })
          if (!resolved.ok) return yield* Effect.fail(new Error(resolved.error))
          const targetID = resolved.id

          const target = yield* sessions
            .get(targetID)
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!target) return yield* Effect.fail(new Error(`Unknown target session: ${targetID}`))

          const text = HandoffTrigger.envelope({
            from: ctx.sessionID,
            agent: ctx.agent,
            message: params.message,
          })
          const messageID = MessageID.ascending()
          const instance = yield* InstanceState.context
          // Audit before waking: the target prompt is forked and may fail (busy
          // run, provider error, cancellation), but the handoff message itself
          // must remain recoverable from the inbox.
          yield* Effect.promise(() =>
            Handoff.HandoffPacket.appendInbox(instance.worktree, targetID, {
              role: "agent",
              sessionID: ctx.sessionID,
              text,
            }),
          )

          const run = yield* EffectBridge.make()
          run.fork(
            ops
              .prompt({
                sessionID: targetID,
                messageID,
                agent: params.agent ?? target.agent,
                parts: [{ type: "text", text, synthetic: true }],
              })
              .pipe(Effect.ignore),
          )

          return {
            title: "Message queued",
            metadata: { sessionID: targetID, messageID },
            output: `Queued message ${messageID} for session ${targetID}; the wake was scheduled asynchronously.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
