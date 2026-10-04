export type LinuxSessionType = "wayland" | "x11" | "unknown"

export function detectSessionType(env: Record<string, string | undefined> = process.env): LinuxSessionType {
  const session = env.XDG_SESSION_TYPE?.toLowerCase()
  if (session === "wayland") return "wayland"
  if (session === "x11") return "x11"
  if (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY.length > 0) return "wayland"
  if (env.DISPLAY !== undefined && env.DISPLAY.length > 0) return "x11"
  return "unknown"
}

// Linux input event codes (KEY_*) used by ydotool. Only the keys the model can
// ask for are mapped; anything else falls back to ydotool type for characters.
export const YDOTOOL_KEYCODES: Record<string, number> = {
  escape: 1,
  esc: 1,
  "1": 2,
  "2": 3,
  "3": 4,
  "4": 5,
  "5": 6,
  "6": 7,
  "7": 8,
  "8": 9,
  "9": 10,
  "0": 11,
  minus: 12,
  equal: 13,
  backspace: 14,
  tab: 15,
  q: 16,
  w: 17,
  e: 18,
  r: 19,
  t: 20,
  y: 21,
  u: 22,
  i: 23,
  o: 24,
  p: 25,
  enter: 28,
  return: 28,
  ctrl: 29,
  control: 29,
  leftctrl: 29,
  a: 30,
  s: 31,
  d: 32,
  f: 33,
  g: 34,
  h: 35,
  j: 36,
  k: 37,
  l: 38,
  semicolon: 39,
  apostrophe: 40,
  grave: 41,
  shift: 42,
  leftshift: 42,
  backslash: 43,
  z: 44,
  x: 45,
  c: 46,
  v: 47,
  b: 48,
  n: 49,
  m: 50,
  comma: 51,
  dot: 52,
  period: 52,
  slash: 53,
  rightshift: 54,
  alt: 56,
  leftalt: 56,
  space: 57,
  capslock: 58,
  f1: 59,
  f2: 60,
  f3: 61,
  f4: 62,
  f5: 63,
  f6: 64,
  f7: 65,
  f8: 66,
  f9: 67,
  f10: 68,
  f11: 87,
  f12: 88,
  rightctrl: 97,
  rightalt: 100,
  home: 102,
  up: 103,
  pageup: 104,
  page_up: 104,
  left: 105,
  right: 106,
  end: 107,
  down: 108,
  pagedown: 109,
  page_down: 109,
  insert: 110,
  delete: 111,
  mute: 113,
  volumedown: 114,
  volumeup: 115,
  pause: 119,
  printscreen: 99,
  sysrq: 99,
  menu: 139,
  scrolllock: 70,
  numlock: 69,
  f13: 183,
  f14: 184,
  f15: 185,
  f16: 186,
  f17: 187,
  f18: 188,
  f19: 189,
  f20: 190,
  f21: 191,
  f22: 192,
  f23: 193,
  f24: 194,
  playpause: 164,
  nextsong: 163,
  previoussong: 165,
  stopcd: 166,
  leftmeta: 125,
  meta: 125,
  cmd: 125,
  super: 125,
  win: 125,
  rightmeta: 126,
}

const MODIFIER_CODES = new Set([29, 97, 42, 54, 56, 100, 125, 126])

export function ydotoolKeySequence(keys: string): string[][] | undefined {
  const parts = keys
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
  const modifiers: number[] = []
  let key: string | undefined
  let nonModifierCount = 0
  for (const part of parts) {
    const code = YDOTOOL_KEYCODES[part]
    if (code !== undefined && MODIFIER_CODES.has(code)) {
      modifiers.push(code)
      continue
    }
    if (code !== undefined || [...part].length === 1) {
      key = part
      nonModifierCount += 1
      continue
    }
    return undefined
  }
  // Multiple non-modifier keys in one combination cannot be expressed by the
  // ydotool key command; silently keeping the last one loses input.
  if (nonModifierCount > 1) return undefined
  if (key === undefined) {
    if (modifiers.length === 0) return undefined
    // A bare modifier (for example "ctrl") is a valid key on its own.
    const bare: string[][] = modifiers.map((code) => ["key", `${code}:1`])
    for (const modifier of [...modifiers].reverse()) bare.push(["key", `${modifier}:0`])
    return bare
  }
  const sequence: string[][] = modifiers.map((code) => ["key", `${code}:1`])
  const code = YDOTOOL_KEYCODES[key]
  if (code !== undefined) {
    sequence.push(["key", `${code}:1`], ["key", `${code}:0`])
  } else if ([...key].length === 1 && modifiers.length === 0) {
    // Text synthesis cannot hold modifiers; a modified punctuation key would
    // be typed as the unmodified character, so refuse instead.
    sequence.push(["type", key])
  } else {
    return undefined
  }
  for (const modifier of [...modifiers].reverse()) sequence.push(["key", `${modifier}:0`])
  return sequence
}

export function ydotoolButtonCodes(button: number): { down: number; up: number } {
  if (button === 3) return { down: 0x41, up: 0x81 }
  if (button === 2) return { down: 0x42, up: 0x82 }
  return { down: 0x40, up: 0x80 }
}

export function ydotoolMoveArgs(x: number, y: number): string[] {
  return ["mousemove", "--absolute", "-x", String(Math.round(x)), "-y", String(Math.round(y))]
}

export function ydotoolReleaseArgs(): string[] {
  return ["key", ...[...MODIFIER_CODES].map((code) => `${code}:0`)]
}
