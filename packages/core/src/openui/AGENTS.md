# OpenUI

Generative UI: the model may answer with a fenced `openui-lang` block, and the client renders it as real components (cards, tables, charts, forms) instead of code.

## What lives here

- `spec.ts`, `schema.ts`, `prompt.ts` — **generated**. Do not edit by hand.
- `types.ts`, `index.ts` — the module's hand-written surface.

`spec.ts` and `schema.ts` are a pruned copy of the official OpenUI component library (`thesysdev/openui`, `@openuidev/react-ui`), and `prompt.ts` is the system prompt generated from that same spec. Keeping both generated from one source is what stops the prompt from advertising a component the client cannot draw: `packages/session-ui/src/openui/registry.ts` declares the renderer map with `satisfies Record<keyof typeof OPENUI_COMPONENTS, …>`, so a missing renderer is a type error.

## Regenerating

    mkdir -p /tmp/openui-extract && cd /tmp/openui-extract && npm init -y
    npm install --legacy-peer-deps zod@4.1.8 @openuidev/lang-core@0.3.2 \
      @openuidev/react-lang@0.4.1 @openuidev/react-ui@0.17.1 \
      @openuidev/react-headless@0.17.0 react@19 react-dom@19 zustand
    cd - && OPENUI_SOURCE_DIR=/tmp/openui-extract bun run script/extract-openui-library.ts

The extractor is not a repo dependency: `@openuidev/react-ui` pulls in React, Radix, d3 and more, which have no business in this lockfile. Add a component by adding it to `COMPONENTS` in `script/extract-openui-library.ts`, regenerating, and implementing a renderer of the same name in `packages/session-ui/src/openui/components/` — the typecheck will name the one you forgot.

`@openuidev/lang-core` is the runtime half: it parses OpenUI Lang against the checked-in schema and is a dependency of `packages/session-ui` only. The server reads `prompt.ts` and nothing else, so the parser never ships to a headless run.

## This build's own components

`extensions.ts` is the hand-written seam for a component upstream does not ship: the schema fragment, the renderers' names, and the prompt section that documents them. The server appends `OPENUI_EXTENSION_PROMPT` to the generated system prompt (`packages/opencode/src/session/system.ts`), and the client merges `mergeOpenUISchema(OPENUI_SCHEMA)` into the parser schema and registers the matching renderers (`packages/session-ui/src/openui/registry.ts`).

Two components live there today, both for graphics the static vocabulary cannot express: `Html` (a complete HTML document in a sandboxed frame with scripts enabled — 3D, WebGL, canvas, animation) and `Svg` (sanitized inline vector markup). A component list in the generated schema (`Card(children)`, `TabItem(content)`) is an `anyOf` of component refs with no way to name them, so the merge re-opens exactly those positions to the extension names.

Adding a component here means all three places move together: the schema fragment, the renderer in `packages/session-ui/src/openui/components/visual.tsx`, and the prompt section. The build stays honest because the prompt section and the schema fragment are in the same file, and `openuiExtensionRenderers` is typed as a renderer map.

## Why the language core and not a runtime

OpenUI ships first-party renderers for React, Vue, Svelte and Angular. This app is Solid, so it uses `lang-core` (parser, prompt generation, JSON Schema — no framework) plus its own Solid components, instead of a port.

## What the client does not do

The prompt keeps the library's inline mode, so the model only draws UI when it helps, and the renderer implements the static vocabulary on the app's own v2 design system (`packages/session-ui/src/openui/theme.ts`): a generated card, table, chart or form draws with the same tokens and controls as the rest of the product, so it follows the theme instead of carrying a look of its own. Deliberately unimplemented, and therefore not advertised beyond their signatures: `Query()`, `Mutation()` and `$variable` two-way bindings (the runtime evaluates them against tools and state this app does not expose), and all of OpenUI's `Action` expressions except a button's `@ToAssistant` message, which clicking sends to the conversation as the next turn (`@OpenUrl` and any other step leave the button inert).
