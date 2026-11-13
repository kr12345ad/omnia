import path from "path"
import { Effect, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

const MAX_SEARCH_RESULTS = 50

type Metadata = {
  name?: string
  dir?: string
  count?: number
}

export const Parameters = Schema.Struct({
  name: Schema.optional(Schema.String).annotate({
    description: "The exact name of the skill to load. Omit to list available skills.",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "When no name is given, search skill names and descriptions for this text.",
  }),
})

export const SkillTool = Tool.define<typeof Parameters, Metadata, Skill.Service | Ripgrep.Service | Agent.Service>(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const ripgrep = yield* Ripgrep.Service
    const agents = yield* Agent.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const name = params.name?.trim()
          if (!name) {
            const agent = yield* agents.get(ctx.agent)
            const list = yield* skill.available(agent)
            const query = params.query?.trim()
            if (query) {
              const needle = query.toLowerCase()
              const matches = list.filter(
                (item) =>
                  item.name.toLowerCase().includes(needle) ||
                  item.description?.toLowerCase().includes(needle),
              )
              const shown = matches.slice(0, MAX_SEARCH_RESULTS)
              return {
                title: `${matches.length} skill${matches.length === 1 ? "" : "s"} matching "${query}"`,
                output:
                  matches.length === 0
                    ? `No skills match "${query}".`
                    : [
                        `Skills matching "${query}" (${matches.length}):`,
                        ...shown.map((item) =>
                          item.description ? `- **${item.name}**: ${item.description}` : `- **${item.name}**`,
                        ),
                        ...(matches.length > shown.length
                          ? [`... ${matches.length - shown.length} more. Narrow the query to see the rest.`]
                          : []),
                      ].join("\n"),
                metadata: { count: matches.length },
              }
            }

            return {
              title: `${list.length} available skill${list.length === 1 ? "" : "s"}`,
              output:
                list.length === 0
                  ? "No skills are currently available."
                  : [
                      `Available skills (${list.length}):`,
                      ...list.map((item) => `- ${item.name}`),
                      "",
                      "Call this tool with `query` to search names and descriptions, or with `name` to load a skill.",
                    ].join("\n"),
              metadata: { count: list.length },
            }
          }

          const info = yield* skill
            .require(name)
            .pipe(Effect.catchTag("Skill.NotFoundError", (error) => Effect.die(new Error(error.message))))

          yield* ctx.ask({
            permission: "skill",
            patterns: [name],
            always: [name],
            metadata: {},
          })

          const dir = path.dirname(info.location)
          const base = dir
          const files = yield* ripgrep.find({
            cwd: dir,
            pattern: "!**/SKILL.md",
            hidden: true,
            follow: false,
            signal: ctx.abort,
            limit: 10,
          })

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name}`,
              "",
              info.content.trim(),
              "",
              `Base directory for this skill: ${base}`,
              "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
              "Note: file list is sampled.",
              "",
              "<skill_files>",
              files.map((file) => `<file>${path.resolve(dir, file.path)}</file>`).join("\n"),
              "</skill_files>",
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              dir,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
