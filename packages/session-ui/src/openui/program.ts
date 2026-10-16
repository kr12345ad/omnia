/**
 * A `JsCard`'s program: the code the model writes, compiled as one async
 * function body so it is called with the card's runtime (`root`, `theme`, …) and
 * may `await` a network import.
 *
 * It lives apart from the renderer because two places have to agree on it
 * exactly. The frame builds the program and runs it; the app compiles the very
 * same program before it mounts a frame at all, so code that cannot compile is
 * reported to the reader instead of run. Compiling is all that is checked here —
 * what the code does once it runs stays the frame's business.
 */

/** The runtime a card's code is called with, in the order the prompt documents it. */
export const CARD_PARAMETERS = ["root", "theme", "size", "dpr", "onResize", "canvas", "setHeight"] as const

/**
 * `"use strict"` plus the wrapper, so the code is a function body: a top-level
 * `await` works, and `return`, `let` and `const` behave the way its author
 * expects. The trailing newline keeps a final `//` comment from swallowing the
 * closing brace.
 */
export const CARD_PROGRAM_HEAD = '"use strict";\nreturn (async () => {\n'
export const CARD_PROGRAM_TAIL = "\n})();"

/**
 * Why this code cannot be a card, in the engine's own words, or `undefined` when
 * it can. The message is passed through rather than rewritten: `Unexpected
 * identifier 'cv'` is what the code's author has to see.
 *
 * A document that forbids dynamic evaluation refuses `new Function` with an
 * `EvalError` rather than a `SyntaxError`, and the check abstains there — the
 * frame could not compile the code either, and reports the failure itself.
 */
export function cardSyntaxError(code: string) {
  try {
    new Function(...CARD_PARAMETERS, CARD_PROGRAM_HEAD + code + CARD_PROGRAM_TAIL)
    return undefined
  } catch (error) {
    return error instanceof SyntaxError ? error.message : undefined
  }
}
