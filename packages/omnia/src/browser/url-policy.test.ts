import { describe, expect, test } from "bun:test"
import {
  BrowserUrlError,
  assertNavigableBrowserUrl,
  isNavigableBrowserUrl,
  isNavigableTabUrl,
  isPrivateHost,
  isTrustedOrigin,
} from "./url-policy"

describe("browser url policy", () => {
  test("allows public http(s) and the blank page", () => {
    expect(isNavigableBrowserUrl("https://example.com/page")).toBe(true)
    expect(isNavigableBrowserUrl("http://example.com:8443/page?q=1")).toBe(true)
    expect(isNavigableBrowserUrl("about:blank")).toBe(true)
  })

  test("blocks non-http schemes", () => {
    expect(isNavigableBrowserUrl("file:///etc/passwd")).toBe(false)
    expect(isNavigableBrowserUrl("javascript:alert(1)")).toBe(false)
    expect(isNavigableBrowserUrl("data:text/html,hi")).toBe(false)
    expect(isNavigableBrowserUrl("chrome://settings")).toBe(false)
  })

  test("blocks loopback, private, link-local, and metadata addresses", () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://127.1/",
      "http://127.0.0.0/",
      "http://127.255.255.254/",
      "http://0.0.0.0/",
      "http://2130706433/",
      "http://0x7f.1/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://017700000001/",
      "http://localhost/",
      "http://app.localhost/",
      "http://10.0.0.1/",
      "http://172.16.5.4/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://169.254.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://100.127.255.254/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fe80::1]/",
      "http://[fe80::1%25eth0]/",
      "http://[fd00::1]/",
      "http://metadata.google.internal/",
    ]) {
      expect(isNavigableBrowserUrl(url), url).toBe(false)
    }
  })

  test("blocks shared, benchmarking, multicast, and reserved IPv4 ranges", () => {
    for (const url of [
      "http://100.64.0.1/",
      "http://198.18.0.1/",
      "http://198.19.255.255/",
      "http://224.0.0.1/",
      "http://239.255.255.255/",
      "http://240.0.0.1/",
      "http://255.255.255.255/",
    ]) {
      expect(isNavigableBrowserUrl(url), url).toBe(false)
    }
  })

  test("blocks unspecified, mapped, 6to4, and NAT64 IPv6 addresses", () => {
    for (const url of [
      "http://[::]/",
      "http://[::ffff:0:0]/",
      "http://[::7f00:1]/",
      "http://[::ffff:10.0.0.1]/",
      "http://[::ffff:192.168.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[2002:7f00:1::]/",
      "http://[2002:a00:1::]/",
      "http://[2002:c0a8:101::]/",
      "http://[2002:a9fe:a9fe::]/",
      "http://[64:ff9b::7f00:1]/",
      "http://[64:ff9b::a00:1]/",
      "http://[64:ff9b::c0a8:101]/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[fe80::abcd]/",
      "http://[fec0::1]/",
      "http://[fec0:1234::1]/",
      "http://[feff:ffff::1]/",
      "http://[64:ff9b:1::7f00:1]/",
      "http://[64:ff9b:1:a00:1::]/",
    ]) {
      expect(isNavigableBrowserUrl(url), url).toBe(false)
    }
  })

  test("blocks trailing-dot FQDNs that spell a private host", () => {
    // A resolvable trailing dot is the FQDN root marker, so `metadata.google.internal.`
    // is the metadata service and must not become navigable.
    for (const url of [
      "http://localhost./",
      "http://app.localhost./",
      "http://db.internal./",
      "http://printer.local./",
      "http://metadata.google.internal./",
      "https://metadata.google.internal./latest/meta-data/",
      "http://127.0.0.1./",
      "http://./",
    ]) {
      expect(isNavigableBrowserUrl(url), url).toBe(false)
    }
    // The audited bypass, spelled exactly as reported.
    expect(isNavigableBrowserUrl("http://metadata.google.internal./")).toBe(false)
  })

  test("blocks trailing-dot spellings of every blocked address form", () => {
    // The dot does not change which host a resolver reaches, so no blocked form
    // may become navigable by gaining one.
    for (const url of [
      "http://127.0.0.1./",
      "http://127.1./",
      "http://2130706433./",
      "http://0x7f.1./",
      "http://0177.0.0.1./",
      "http://10.0.0.1./",
      "http://192.168.1.1./",
      "http://169.254.169.254./latest/meta-data/",
      "http://[::1]./",
      "http://[::ffff:127.0.0.1]./",
      "http://[fe80::abcd]./",
      "http://[fd00::1]./",
      "http://[2002:7f00:1::]./",
      "http://[64:ff9b::7f00:1]./",
      "http://localhost.:8080/",
      "http://LOCALHOST./",
      "http://db.internal..",
      "http://intranet./",
      "http://build-server./",
    ]) {
      expect(isNavigableBrowserUrl(url), url).toBe(false)
    }
  })

  test("refuses the dotted spelling of a public name instead of trusting it", () => {
    // `example.com.` resolves to example.com, but a trailing dot is also how a
    // resolver is fed a name whose search-domain form is local, so the policy
    // refuses it outright instead of normalizing it into public space.
    expect(isNavigableBrowserUrl("https://example.com./")).toBe(false)
    expect(isPrivateHost("example.com.")).toBe(true)
    // The undotted public name is still allowed.
    expect(isNavigableBrowserUrl("https://example.com/")).toBe(true)
  })

  test("blocks single-label hosts that only resolve through local DNS", () => {
    for (const url of ["http://intranet/", "http://router/", "http://build-server./"]) {
      expect(isNavigableBrowserUrl(url), url).toBe(false)
    }
  })

  test("allows public IPv6 addresses", () => {
    expect(isNavigableBrowserUrl("http://[2606:4700:4700::1111]/")).toBe(true)
    expect(isNavigableBrowserUrl("http://[2001:4860:4860::8888]/")).toBe(true)
    // A public translation prefix stays public.
    expect(isNavigableBrowserUrl("http://[64:ff9b::808:808]/")).toBe(true)
    expect(isNavigableBrowserUrl("http://[2002:808:808::]/")).toBe(true)
  })

  test("tab navigability matches browser navigability including about:blank", () => {
    expect(isNavigableTabUrl("about:blank")).toBe(true)
    expect(isNavigableTabUrl("https://example.com")).toBe(true)
    expect(isNavigableTabUrl("about:config")).toBe(false)
    expect(isNavigableTabUrl("about:srcdoc")).toBe(false)
    expect(isNavigableTabUrl("file:///etc/passwd")).toBe(false)
    expect(isNavigableTabUrl("http://127.0.0.1/")).toBe(false)
  })

  test("exposes the shared host classifier", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true)
    expect(isPrivateHost("100.64.1.1")).toBe(true)
    expect(isPrivateHost("224.0.0.1")).toBe(true)
    expect(isPrivateHost("localhost.")).toBe(true)
    expect(isPrivateHost("db.internal.")).toBe(true)
    expect(isPrivateHost("127.0.0.1.")).toBe(true)
    expect(isPrivateHost("metadata.google.internal.")).toBe(true)
    expect(isPrivateHost("example.com.")).toBe(true)
    expect(isPrivateHost("intranet")).toBe(true)
    expect(isPrivateHost("::1")).toBe(true)
    expect(isPrivateHost("2001:4860:4860::8888")).toBe(false)
    expect(isPrivateHost("example.com")).toBe(false)
  })

  test("throws a stable error code", () => {
    try {
      assertNavigableBrowserUrl("file:///etc/passwd")
      throw new Error("expected the policy to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserUrlError)
      expect((error as BrowserUrlError).code).toBe("url_blocked")
    }
  })
})

describe("operator trusted origins", () => {
  const withEnv = (value: string | undefined, fn: () => void) => {
    const previous = process.env.OMNIA_BROWSER_TRUSTED_ORIGINS
    if (value === undefined) delete process.env.OMNIA_BROWSER_TRUSTED_ORIGINS
    else process.env.OMNIA_BROWSER_TRUSTED_ORIGINS = value
    try {
      fn()
    } finally {
      if (previous === undefined) delete process.env.OMNIA_BROWSER_TRUSTED_ORIGINS
      else process.env.OMNIA_BROWSER_TRUSTED_ORIGINS = previous
    }
  }

  test("private hosts stay blocked when nothing is configured", () => {
    withEnv(undefined, () => {
      expect(isNavigableBrowserUrl("http://localhost:8012/")).toBe(false)
      expect(isNavigableBrowserUrl("http://127.0.0.1:8012/")).toBe(false)
    })
  })

  test("an empty or blank value trusts nothing", () => {
    for (const value of ["", "   "]) {
      withEnv(value, () => {
        expect(isNavigableBrowserUrl("http://localhost:8012/")).toBe(false)
      })
    }
  })

  test("a configured origin makes exactly that origin navigable", () => {
    withEnv("http://localhost:8012", () => {
      expect(isNavigableBrowserUrl("http://localhost:8012/simulator")).toBe(true)
      // Public sites are unaffected by the opt-in.
      expect(isNavigableBrowserUrl("https://example.com/")).toBe(true)
    })
  })

  test("the grant is per scheme, host, and port, never widened", () => {
    withEnv("http://localhost:8012", () => {
      expect(isNavigableBrowserUrl("http://localhost:22/")).toBe(false)
      expect(isNavigableBrowserUrl("https://localhost:8012/")).toBe(false)
      expect(isNavigableBrowserUrl("http://127.0.0.1:8012/")).toBe(false)
      expect(isNavigableBrowserUrl("http://evil.localhost:8012/")).toBe(false)
    })
  })

  test("a path, credentials, or wildcard in the entry cannot widen the grant", () => {
    withEnv("http://localhost:8012/admin", () => {
      // Only the origin is trusted, so the path is ignored rather than honoured.
      expect(isTrustedOrigin(new URL("http://localhost:8012/anything-else"))).toBe(true)
    })
    withEnv("http://user:pass@localhost:8012", () => {
      expect(isNavigableBrowserUrl("http://localhost:8012/")).toBe(true)
    })
    withEnv("http://*.localhost:8012", () => {
      expect(isNavigableBrowserUrl("http://localhost:8012/")).toBe(false)
    })
  })

  test("several origins may be listed", () => {
    withEnv("http://localhost:8012, https://internal.test:9000", () => {
      expect(isNavigableBrowserUrl("http://localhost:8012/")).toBe(true)
      expect(isNavigableBrowserUrl("https://internal.test:9000/x")).toBe(true)
      expect(isNavigableBrowserUrl("http://localhost:9999/")).toBe(false)
    })
  })

  test("malformed entries are skipped rather than fatal", () => {
    withEnv("not a url, http://localhost:8012", () => {
      expect(isNavigableBrowserUrl("http://localhost:8012/")).toBe(true)
    })
  })
})