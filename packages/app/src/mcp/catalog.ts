import type { MarketplaceServer } from "./marketplace"

let pending: Promise<MarketplaceServer[]> | undefined

// The generated catalog is several megabytes, so it stays a separate chunk that
// is only parsed when the marketplace is opened, never during app start.
export function loadCatalog() {
  pending ??= import("./marketplace.json")
    .then((module) => (module.default as { servers: MarketplaceServer[] }).servers)
    .catch((error) => {
      pending = undefined
      throw error
    })
  return pending
}

export function resetCatalog() {
  pending = undefined
}
