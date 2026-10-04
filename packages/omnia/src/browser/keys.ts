// Key chord parsing shared by the embedded CDP keyboard path.

export type KeyModifier = "Alt" | "Control" | "Meta" | "Shift"

export interface KeyDefinition {
  readonly key: string
  readonly code: string
  readonly keyCode: number
  readonly text?: string
  readonly unmodifiedText?: string
}

export interface KeyChord {
  readonly modifiers: readonly KeyModifier[]
  readonly definition: KeyDefinition
}

const MODIFIER_ALIASES: Readonly<Record<string, KeyModifier>> = {
  alt: "Alt",
  option: "Alt",
  ctrl: "Control",
  control: "Control",
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  shift: "Shift",
}

const CDP_MODIFIER_MASK: Readonly<Record<KeyModifier, number>> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
}

const NAMED_KEYS: Readonly<Record<string, Omit<KeyDefinition, "key">>> = {
  enter: { code: "Enter", keyCode: 13, text: "\r" },
  return: { code: "Enter", keyCode: 13, text: "\r" },
  tab: { code: "Tab", keyCode: 9, text: "\t" },
  escape: { code: "Escape", keyCode: 27 },
  esc: { code: "Escape", keyCode: 27 },
  backspace: { code: "Backspace", keyCode: 8 },
  delete: { code: "Delete", keyCode: 46 },
  del: { code: "Delete", keyCode: 46 },
  insert: { code: "Insert", keyCode: 45 },
  arrowup: { code: "ArrowUp", keyCode: 38 },
  up: { code: "ArrowUp", keyCode: 38 },
  arrowdown: { code: "ArrowDown", keyCode: 40 },
  down: { code: "ArrowDown", keyCode: 40 },
  arrowleft: { code: "ArrowLeft", keyCode: 37 },
  left: { code: "ArrowLeft", keyCode: 37 },
  arrowright: { code: "ArrowRight", keyCode: 39 },
  right: { code: "ArrowRight", keyCode: 39 },
  home: { code: "Home", keyCode: 36 },
  end: { code: "End", keyCode: 35 },
  pageup: { code: "PageUp", keyCode: 33 },
  pagedown: { code: "PageDown", keyCode: 34 },
  space: { code: "Space", keyCode: 32, text: " " },
}

export function parseKeyChord(input: string): KeyChord {
  // A trailing "++" (or a bare "+") names the plus key: "+", "Control++", and
  // the "plus" alias all mean the literal character that splits chord parts.
  const plusKey = input === "+" || input.endsWith("++")
  const parts = input.split("+")
  const modifierParts = plusKey ? (input === "+" ? [] : parts.slice(0, -2)) : parts.slice(0, -1)
  const modifiers: KeyModifier[] = []
  for (const part of modifierParts) {
    const modifier = MODIFIER_ALIASES[part.trim().toLowerCase()]
    if (modifier === undefined) throw new Error(`Unknown key modifier "${part}".`)
    if (!modifiers.includes(modifier)) modifiers.push(modifier)
  }
  const key = plusKey ? "+" : (parts[parts.length - 1] ?? "")
  if (key.length === 0) throw new Error("A key is required.")
  return { modifiers, definition: keyDefinition(key, modifiers) }
}

export function cdpModifierMask(modifiers: readonly KeyModifier[]): number {
  return modifiers.reduce((mask, modifier) => mask | CDP_MODIFIER_MASK[modifier], 0)
}

function keyDefinition(key: string, modifiers: readonly KeyModifier[]): KeyDefinition {
  if (key === "+" || key.toLowerCase() === "plus") {
    return { key: "+", code: "NumpadAdd", keyCode: 107, text: "+", unmodifiedText: "+" }
  }
  const named = NAMED_KEYS[key.toLowerCase()]
  if (named !== undefined) return { key, ...named, ...(named.text === undefined ? {} : { unmodifiedText: named.text }) }
  if (key.length === 1) {
    const upper = key.toUpperCase()
    const shift = modifiers.includes("Shift")
    if (/[a-z]/iu.test(key)) {
      return {
        key,
        code: `Key${upper}`,
        keyCode: upper.charCodeAt(0),
        text: shift ? upper : key.toLowerCase(),
        unmodifiedText: key.toLowerCase(),
      }
    }
    if (/[0-9]/u.test(key)) {
      return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key, unmodifiedText: key }
    }
    return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key, unmodifiedText: key }
  }
  const functionKey = /^f([1-9]|1[0-2])$/iu.exec(key)
  if (functionKey !== null) {
    const index = Number(functionKey[1])
    return {
      key: `F${index}`,
      code: `F${index}`,
      keyCode: 111 + index,
    }
  }
  return { key, code: key, keyCode: 0 }
}
