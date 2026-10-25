// The effort levels are named steps, not a number, so the thumb follows the
// pointer freely while dragging but the value only ever lands on a stop.
export function promptInputV2VariantStop(position: number, stops: number) {
  if (stops <= 1) return 0
  const clamped = Math.min(1, Math.max(0, position))
  return Math.round(clamped * (stops - 1))
}

// Pointer position along the rail, in reading order: a right-to-left rail runs
// from the right edge, so its position is mirrored.
export function promptInputV2VariantPosition(clientX: number, rail: { left: number; width: number }, rtl: boolean) {
  if (rail.width <= 0) return 0
  const position = (clientX - rail.left) / rail.width
  return Math.min(1, Math.max(0, rtl ? 1 - position : position))
}
