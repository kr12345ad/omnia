export function number(value: number): string {
  if (!Number.isFinite(value)) return "—"
  return new Intl.NumberFormat("en-US").format(Math.round(value))
}

export function compact(value: number): string {
  if (!Number.isFinite(value)) return "—"
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

export function usd(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 1000 ? 0 : digits,
    maximumFractionDigits: value >= 1000 ? 0 : digits,
  }).format(value)
}

export function percent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—"
  return `${value.toFixed(digits)}%`
}

export function date(value: number | undefined): string {
  if (value === undefined) return "—"
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function shortDate(value: number | undefined): string {
  if (value === undefined) return "—"
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export function dateTime(value: number | undefined): string {
  if (value === undefined) return "—"
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function relative(value: number | undefined): string {
  if (value === undefined) return "never"
  const seconds = Math.round((Date.now() - value) / 1000)
  if (seconds < 45) return "just now"
  if (seconds < 90) return "a minute ago"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months} mo ago`
  return date(value)
}

export function until(value: number | undefined): string {
  if (value === undefined) return "—"
  const days = Math.ceil((value - Date.now()) / 86_400_000)
  if (days < 0) return "expired"
  if (days === 0) return "today"
  if (days === 1) return "tomorrow"
  if (days < 45) return `in ${days} days`
  return `on ${date(value)}`
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase()
}

export function titleCase(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim()
}

export function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${number(count)} ${count === 1 ? singular : pluralForm}`
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
