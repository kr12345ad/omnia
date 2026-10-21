import { createSignal } from "solid-js"

// Hash routing keeps the console a single static file: every route is
// `/admin/#/...`, so a deep link works without a server rewrite rule and the
// server never has to guess whether a path is an asset or a page.

function read(): string {
  if (typeof window === "undefined") return "/overview"
  const raw = window.location.hash.replace(/^#/, "")
  if (raw.length === 0) return "/overview"
  return raw.startsWith("/") ? raw : `/${raw}`
}

const [current, setCurrent] = createSignal(read())

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => setCurrent(read()))
}

export function currentPath(): string {
  return current()
}

export function routePath(): string {
  return current().split("?")[0] ?? "/"
}

export function routeSegments(): string[] {
  return routePath()
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
}

export function routeQuery(): URLSearchParams {
  const index = current().indexOf("?")
  return new URLSearchParams(index === -1 ? "" : current().slice(index + 1))
}

export function navigate(path: string): void {
  const next = path.startsWith("#") ? path.slice(1) : path
  if (window.location.hash === `#${next}`) return
  window.location.hash = next.startsWith("/") ? next : `/${next}`
}

export function href(path: string): string {
  return `#${path.startsWith("/") ? path : `/${path}`}`
}
