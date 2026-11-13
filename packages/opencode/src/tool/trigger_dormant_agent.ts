import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { Tool } from "./tool"
import type { TaskPromptOps } from "./task"
import { Handoff } from "@/handoff"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"

type Metadata = {
  agent: string
  packet: string
  background?: boolean
  taskID?: string
  status?: "pending" | "running" | "completed" | "failed"
}

export const Parameters = Schema.Struct({
  agent: Schema.String.annotate({
    description: "Name from a `.omnia/agents/*.md` file whose frontmatter sets dormant: true.",
  }),
  reason: Schema.String.annotate({
    description: "What the dormant agent should analyze. Include the failure, question, or target files.",
  }),
  wait: Schema.optional(Schema.Boolean).annotate({
    description: "Wait for the analysis and return it (default), or start it and return immediately.",
  }),
})

/**
 * Manual half of the handoff supervisor. The automatic hook calls the same
 * runner after a failing test; this tool lets the main agent request a dormant
 * analysis for anything else (a flaky reproduction, a stack trace, a review).
 */
export const TriggerDormantAgentTool = Tool.define<typeof Parameters, Metadata, Session.Service | Agent.Service>(
  "trigger_dormant_agent",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service

    return {
      description: [
        "Hydrate a dormant sub-agent from `.omnia/agents/*.md` for one diagnostic turn.",
        "The agent runs in a child session with the handoff packet and captured output, then returns a short diagnosis.",
        "Use wait=false to continue working while it runs; its result is delivered back as a synthetic message.",
        "Usable from a root session or a regular task/discussion subagent; a handoff-spawned session cannot start another handoff.",
        "Automatic test-failure handoffs do not need this tool.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!ops) return yield* Effect.fail(new Error("trigger_dormant_agent requires an active session runtime"))

          const instance = yield* InstanceState.context
          const current = yield* sessions.get(ctx.sessionID)
          // The recursion boundary is the handoff marker, matching
          // Handoff.prepare: a regular task or discussion subagent may hydrate
          // a specialist for its own failure, but a specialist spawned by a
          // handoff cannot chain another handoff.
          if (current.metadata?.handoff) {
            return yield* Effect.fail(
              new Error(
                "A handoff-spawned session cannot hydrate another dormant agent; use send_message to report upward.",
              ),
            )
          }
          const available = yield* Effect.promise(() => Handoff.HandoffDormant.scan(instance.worktree))
          const dormant = available.find((item) => item.name === params.agent)
          if (!dormant) {
            const names = available.map((item) => item.name)
            return yield* Effect.fail(
              new Error(
                names.length === 0
                  ? `No dormant agents are registered in ${instance.worktree}/.omnia/agents`
                  : `Unknown dormant agent "${params.agent}". Available: ${names.join(", ")}`,
              ),
            )
          }

          const prepared = yield* Effect.promise(() =>
            Handoff.prepareManual({
              root: instance.worktree,
              session: {
                id: current.id,
                parentID: current.parentID,
                agent: current.agent,
                directory: current.directory,
              },
              agent: dormant,
              reason: params.reason,
              messages: ctx.messages,
            }),
          )
          const work = Handoff.run({
            prepared,
            agent: dormant,
            parent: { id: current.id, agent: current.agent },
            ops,
            sessions,
            agents,
            // A foreground call returns the summary itself; a background call
            // must push it back because the tool result has already returned.
            deliver: params.wait === false,
          })

          if (params.wait === false) {
            const run = yield* EffectBridge.make()
            run.fork(work.pipe(Effect.ignore))
            return {
              title: "Dormant agent started",
              metadata: { agent: dormant.name, packet: prepared.packet.id, background: true },
              output: [
                `Started ${dormant.name} in the background (packet ${prepared.packet.id}).`,
                "Its diagnosis will arrive as a synthetic message when it finishes.",
              ].join(" "),
            }
          }

          yield* work
          const finished = yield* Effect.promise(() =>
            Handoff.HandoffPacket.read(instance.worktree, current.id),
          )
          const summary = finished?.summary?.trim() || finished?.error || "The dormant agent returned no text."
          return {
            title: dormant.name,
            metadata: {
              agent: dormant.name,
              packet: prepared.packet.id,
              taskID: finished?.taskID,
              status: finished?.status,
            },
            output: summary,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
