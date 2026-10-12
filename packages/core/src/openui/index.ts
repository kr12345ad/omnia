// OpenUI Lang support shared by the client and the server.
//
// The component library is a subset of the official OpenUI component library
// (thesysdev/openui, `@openuidev/react-ui`) and is frozen in `./spec.ts` and
// `./schema.ts`. The client renders those components with Solid; the server
// injects `OPENUI_SYSTEM_PROMPT`, generated from the same spec, so the prompt
// only ever advertises components the client can actually draw.
//
// Regeneration is documented in AGENTS.md.
export * as OpenUI from "./index"
export { OPENUI_COMPONENTS, OPENUI_COMPONENT_GROUPS, OPENUI_ROOT } from "./spec"
export { OPENUI_SCHEMA } from "./schema"
export { OPENUI_SYSTEM_PROMPT } from "./prompt"
// This build's own components, hand-written: the generated library can only
// describe what upstream ships. See ./extensions.ts.
export {
  OPENUI_EXTENSION_COMPONENTS,
  OPENUI_EXTENSION_PROMPT,
  OPENUI_EXTENSION_SCHEMA,
  OPENUI_EXTENSION_SIGNATURES,
  mergeOpenUISchema,
} from "./extensions"
export type { OpenUIExtensionComponent } from "./extensions"
export type {
  OpenUIComponentGroup,
  OpenUIComponentSpec,
  OpenUIElement,
  OpenUIJSONSchema,
  OpenUILibrarySchema,
  OpenUIParseResult,
  OpenUIValidationError,
} from "./types"
export { isOpenUIElement } from "./types"
