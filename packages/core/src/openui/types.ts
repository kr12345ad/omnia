// Framework-agnostic OpenUI Lang types.
//
// These mirror the shape `@openuidev/lang-core` parses and validates against, so
// the app's Solid renderer and the server's system prompt share one vocabulary
// without either of them importing a UI framework.

/** A JSON Schema document (draft 2020-12) restricted to what a component library needs. */
export type OpenUIJSONSchema = Record<string, unknown>

/** The JSON Schema document `createParser` accepts: one `$defs` entry per component. */
export interface OpenUILibrarySchema {
  $schema?: string
  type?: string
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  $defs?: Record<string, OpenUIJSONSchema>
}

/** One component as OpenUI Lang sees it: a positional signature plus prose. */
export interface OpenUIComponentSpec {
  signature: string
  description?: string
}

/** A named bundle of components the prompt presents together. */
export interface OpenUIComponentGroup {
  name: string
  components: string[]
  notes?: string[]
}

/** A resolved node from the parser: one component invocation with named props. */
export interface OpenUIElement {
  type: "element"
  statementId?: string
  typeName: string
  props: Record<string, unknown>
  partial: boolean
}

/** A prop validation error the parser reports instead of failing the whole program. */
export interface OpenUIValidationError {
  code: string
  component: string
  path: string
  message: string
  statementId?: string
}

/** The subset of `@openuidev/lang-core`'s ParseResult our renderer reads. */
export interface OpenUIParseResult {
  root: OpenUIElement | null
  meta: {
    incomplete: boolean
    unresolved: string[]
    orphaned: string[]
    statementCount: number
    errors: OpenUIValidationError[]
  }
}

export function isOpenUIElement(value: unknown): value is OpenUIElement {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<OpenUIElement>
  return candidate.type === "element" && typeof candidate.typeName === "string" && typeof candidate.props === "object"
}
