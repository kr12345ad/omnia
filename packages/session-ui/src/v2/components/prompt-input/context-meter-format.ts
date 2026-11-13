/** Compact token notation: 999, 12.3k, 1.2m. */
export function formatContextTokens(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value < 1_000) return Math.round(value).toString()
  if (value < 1_000_000) {
    const thousands = value / 1_000
    if (thousands >= 999.5) return "1m"
    return `${thousands < 10 ? Number(thousands.toFixed(1)) : Math.round(thousands)}k`
  }
  const millions = value / 1_000_000
  return `${millions < 10 ? Number(millions.toFixed(1)) : Math.round(millions)}m`
}

/**
 * The meter turns amber before the window is full and red once there is little
 * room left. A missing ceiling is unknown, not empty, so it stays neutral.
 */
export function contextPressure(used: number, limit: number | undefined) {
  if (limit === undefined || limit <= 0) return "normal" as const
  const ratio = Math.min(1, Math.max(0, used / limit))
  if (ratio > 0.85) return "danger" as const
  if (ratio >= 0.6) return "warning" as const
  return "normal" as const
}
