// Navigation allowlist for the controlled browser. Pages must not be able to
// steer the runtime at local services or cloud metadata endpoints. This is the
// single shared policy for the server runtime, the desktop shell, the app
// address bar, and the model-facing tool.

export class BrowserUrlError extends Error {
  readonly code = "url_blocked"

  constructor(message: string) {
    super(message)
    this.name = "BrowserUrlError"
  }
}

export function isNavigableBrowserUrl(value: string): boolean {
  if (value === "about:blank") return true
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return !isPrivateHost(url.hostname) || isTrustedOrigin(url)
}

// Operator opt-in for privately addressed hosts, used to reach a locally hosted
// benchmark or development server (WebArena, a preview deployment).
//
// Empty unless OMNIA_BROWSER_TRUSTED_ORIGINS is set, so the SSRF guard is
// unchanged for everyone who does not configure it. Matching is on scheme, host
// and port together: a trusted `http://localhost:8012` must not silently make
// `http://localhost:22` or `https://localhost:8012` navigable either, and a
// wildcard host is refused outright rather than half-honoured.
export function isTrustedOrigin(url: URL): boolean {
  const configured = process.env.OMNIA_BROWSER_TRUSTED_ORIGINS
  if (configured === undefined || configured.trim().length === 0) return false
  for (const entry of configured.split(",")) {
    const candidate = entry.trim()
    if (candidate.length === 0) continue
    if (!URL.canParse(candidate)) continue
    const trusted = new URL(candidate)
    if (trusted.protocol !== "http:" && trusted.protocol !== "https:") continue
    // A path or credentials in the configured entry are ignored for matching:
    // only the origin is ever trusted, so an operator cannot widen the grant
    // with `http://localhost:8012/admin`.
    if (trusted.hostname.length === 0 || trusted.hostname.includes("*")) continue
    if (trusted.origin !== url.origin) continue
    return true
  }
  return false
}

// Tab identity follows the same allowlist as navigation. about:blank is a
// real navigable tab target even though it carries no page.
export function isNavigableTabUrl(value: string): boolean {
  return isNavigableBrowserUrl(value)
}

// The desktop ships a local pdf.js reader page. Its address is not a public web
// address, but it is the document the browser tools must read and fill after a
// PDF navigation is redirected. Only the built-in reader shape is admitted:
// the oc://renderer document in a packaged app, or the same path on the Vite
// dev server during development.
export function isPdfReaderBrowserDocument(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.pathname !== "/pdf.html") return false
  if (url.searchParams.get("url") === null) return false
  if (url.protocol === "oc:" && url.host === "renderer") return true
  const dev = devRendererOrigin()
  return dev !== undefined && url.origin === dev
}

// The reader's module scripts, worker, and styles live beside the document on
// the same local origin. They are app assets, not web content, so the request
// policy admits them along with the document without widening navigation.
export function isPdfReaderBrowserResource(value: string): boolean {
  if (isPdfReaderBrowserDocument(value)) return true
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol === "oc:" && url.host === "renderer") return true
  const dev = devRendererOrigin()
  return dev !== undefined && url.origin === dev
}

function devRendererOrigin(): string | undefined {
  const value = process.env.ELECTRON_RENDERER_URL
  if (value === undefined || !URL.canParse(value)) return undefined
  return new URL(value).origin
}

export function assertNavigableBrowserUrl(value: string): string {
  if (isNavigableBrowserUrl(value)) return value
  throw new BrowserUrlError(`Refusing to navigate to ${value}. Only public http(s) addresses are allowed.`)
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase()
  if (host.length === 0) return true
  // The trailing dot is the FQDN root marker and every resolver ignores it, so
  // `localhost.`, `db.internal.` and `metadata.google.internal.` reach the same
  // private services as the bare names. Classification normalizes it away, and
  // the dotted spelling is rejected outright rather than trusted as public.
  if (host.endsWith(".")) return true
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true
  }
  if (isPrivateIpv4(host)) return true
  // IPv6 literals split off from DNS names here: an unparsable literal is
  // private, while a public literal stays public.
  if (host.includes(":")) return isPrivateIpv6(host)
  // A single-label name carries no public suffix, so it can only resolve
  // through the machine's own DNS search domains. Never public.
  return !host.includes(".")
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".")
  if (parts.length !== 4) return false
  const octets = parts.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : Number.NaN))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [first, second] = octets as [number, number, number, number]
  if (first === 0 || first === 10 || first === 127) return true
  if (first === 169 && second === 254) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 100 && second >= 64 && second <= 127) return true
  if (first === 198 && (second === 18 || second === 19)) return true
  return first >= 224
}

function isPrivateIpv6(host: string): boolean {
  if (!host.includes(":")) return false
  const groups = expandIpv6(host)
  if (groups === undefined) return true
  const first = groups[0] ?? 0
  if (groups.every((group) => group === 0)) return true
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true
  if ((first & 0xfe00) === 0xfc00) return true
  if ((first & 0xffc0) === 0xfe80) return true
  // The deprecated site-local range (RFC 3879) is still unicast inside a site,
  // so it is private even though it was never a public allocation.
  if ((first & 0xffc0) === 0xfec0) return true
  // IPv4-mapped ::ffff:0:0/96 and the deprecated IPv4-compatible ::/96.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return isPrivateEmbeddedIpv4(groups[6], groups[7])
  }
  if (groups.slice(0, 6).every((group) => group === 0) && (groups[6] !== 0 || groups[7] !== 0)) {
    return isPrivateEmbeddedIpv4(groups[6], groups[7])
  }
  // 6to4 (2002::/16) and NAT64 (64:ff9b::/96) embed an IPv4 address in the
  // low bits. The local-use translation prefix 64:ff9b:1::/48 (RFC 8215) only
  // ever reaches a translator on the local network, so it is private outright.
  if (first === 0x2002) return isPrivateEmbeddedIpv4(groups[1], groups[2])
  if (groups[0] === 0x64 && groups[1] === 0xff9b) {
    if (groups[2] === 0x1) return true
    return isPrivateEmbeddedIpv4(groups[6], groups[7])
  }
  return false
}

function expandIpv6(host: string): number[] | undefined {
  const zone = host.indexOf("%")
  const address = (zone >= 0 ? host.slice(0, zone) : host).toLowerCase()
  const double = address.indexOf("::")
  if (double < 0) {
    const parsed = address.split(":").map(parseIpv6Group)
    return parsed.length === 8 && parsed.every((group): group is number => group !== undefined) ? parsed : undefined
  }
  if (address.indexOf("::", double + 2) >= 0) return undefined
  const head = address.slice(0, double).split(":").filter((part) => part.length > 0)
  const tail = address.slice(double + 2).split(":").filter((part) => part.length > 0)
  if (head.length + tail.length > 7) return undefined
  const parsed = [...head, ...tail].map(parseIpv6Group)
  if (!parsed.every((group): group is number => group !== undefined)) return undefined
  return [
    ...parsed.slice(0, head.length),
    ...Array.from({ length: 8 - head.length - tail.length }, () => 0),
    ...parsed.slice(head.length),
  ]
}

function parseIpv6Group(part: string): number | undefined {
  return /^[0-9a-f]{1,4}$/u.test(part) ? Number.parseInt(part, 16) : undefined
}

function isPrivateEmbeddedIpv4(high: number | undefined, low: number | undefined): boolean {
  if (high === undefined || low === undefined) return false
  const octets = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff]
  return isPrivateIpv4(octets.join("."))
}
