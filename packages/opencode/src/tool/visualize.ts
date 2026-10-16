import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./visualize.txt"

export const Parameters = Schema.Struct({
  code: Schema.NonEmptyString.annotate({
    description: "One openui-lang program that draws the visualization, defining `root`.",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "Optional short heading shown above the drawing.",
  }),
})

type VisualizeMetadata = {
  title?: string
}

/**
 * The program itself never enters the result: the client draws it from the tool
 * call's own arguments, so `output` stays a single readable line and the user
 * never watches raw markup stream through the chat.
 */
export const VisualizeTool = Tool.define<typeof Parameters, VisualizeMetadata, never>(
  "visualize",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>) => {
      const title = params.title?.trim()
      if (!title) {
        return Effect.succeed({
          title: "Rendered a visualization",
          output: "Rendered the visualization.",
          metadata: {},
        })
      }
      return Effect.succeed({
        title: `Rendered ${title}`,
        output: `Rendered ${title}.`,
        metadata: { title },
      })
    },
  } satisfies Tool.DefWithoutID<typeof Parameters, VisualizeMetadata>),
)
