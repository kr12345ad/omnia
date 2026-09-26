import { describe, expect, test } from "bun:test"
import {
  AdapterRegistry,
  BACKEND_IDS,
  BROWSER_BACKEND,
  DEFAULT_COMPUTER_ADAPTERS,
  applyPermissionStatus,
  applyWaylandLimitations,
  createAdapterFromProtocolDriver,
  createApplicationProfile,
  createCapabilityProfile,
  createCapabilitySupport,
  createUnavailableCapabilityProfile,
  getRegisteredAdapter,
  rankBackends,
  registerAdapter,
  unregisterRegisteredAdapter,
  selectBackend,
  type BackendDescriptor,
  type CapabilityDiscovery,
  type CapabilityProfile,
  type ComputerAdapter,
  type ComputerDriver,
  type ComputerResult,
  type Limitation,
  type ProtocolDriver,
  toProtocolCapabilitySupport,
  toProtocolComputerInfo,
} from "./index"

const fixtureBackend: BackendDescriptor = {
  id: "fixture",
  name: "Fixture",
  platform: "linux",
  kind: "native",
  displayServers: ["wayland"],
  priority: 50,
  experimental: false,
  requiresPermission: true,
  responsiveness: 0.8,
  metadata: {},
}

const fixtureProfile: CapabilityProfile = createCapabilityProfile({
  backend: fixtureBackend,
  displayServer: "wayland",
  capabilities: {
    observe: createCapabilitySupport({ capability: "observe", status: "available" }),
    screenshot: createCapabilitySupport({ capability: "screenshot", status: "available" }),
    click: { capability: "click", status: "unavailable" },
  },
})

const unavailableResult: ComputerResult = {
  success: false,
  status: "unavailable",
  message: "Fixture unavailable.",
  limitations: [],
}

function fixtureAdapter(
  profile: CapabilityProfile,
  applications: CapabilityDiscovery["applications"] = [],
): ComputerAdapter {
  const driver: ComputerDriver = {
    id: profile.backend.id,
    backend: profile.backend.id,
    descriptor: profile.backend,
    platform: profile.backend.platform,
    discover: async () => ({
      profile,
      applications,
      limitations: profile.limitations,
      observedAt: 1,
    }),
    getCapabilities: async () => profile,
    listApplications: async () => applications,
    observe: async () => ({ timestamp: 1, elements: [], source: "native", backend: profile.backend.id }),
    execute: async () => unavailableResult,
  }
  return { descriptor: profile.backend, createDriver: () => driver }
}

describe("computer adapter contracts", () => {
  test("default adapters are honest unavailable registrations", async () => {
    const registry = new AdapterRegistry({ adapters: DEFAULT_COMPUTER_ADAPTERS })
    expect(registry.list().map((adapter) => adapter.descriptor.id)).toEqual([
      BACKEND_IDS.macosAx,
      BACKEND_IDS.windowsUia,
      BACKEND_IDS.linuxAtSpi,
      BACKEND_IDS.browser,
      BACKEND_IDS.future,
    ])
    const discovery = await registry.discover({ includeUnavailable: true })
    expect(discovery.every((entry) => entry.profile.status === "unavailable")).toBe(true)
    const driver = await registry.createDriver(BROWSER_BACKEND.id)
    expect((await driver.execute({ type: "observe" })).status).toBe("unavailable")
    const macProfile = await (await registry.createDriver(BACKEND_IDS.macosAx)).getCapabilities()
    expect(macProfile.permissions.some((permission) => permission.id === "accessibility")).toBe(true)
  })

  test("registration rejects duplicates unless replacement is requested", () => {
    const registry = new AdapterRegistry()
    const adapter = fixtureAdapter(fixtureProfile)
    registry.register(adapter)
    expect(() => registry.register(adapter)).toThrow()
    expect(registry.register(adapter, { replace: true })).toBe(registry)
    expect(registry.has(adapter.descriptor.id)).toBe(true)
  })

  test("supports global adapter registration for host integrations", () => {
    const adapter = fixtureAdapter({ ...fixtureProfile, backend: { ...fixtureBackend, id: "global-fixture" } })
    registerAdapter(adapter)
    expect(getRegisteredAdapter(adapter.descriptor.id)).toBe(adapter)
    expect(unregisterRegisteredAdapter(adapter.descriptor.id)).toBe(true)
  })

  test("discovery turns adapter failures into unavailable profiles", async () => {
    const registry = new AdapterRegistry()
    registry.register({
      descriptor: fixtureBackend,
      createDriver: () => {
        throw new Error("host failed")
      },
    })
    const [result] = await registry.discover({ includeUnavailable: true })
    expect(result?.profile.status).toBe("unavailable")
    expect(result?.error).toBeInstanceOf(Error)
  })
})

describe("capability profiles", () => {
  test("quality scoring rewards available capabilities over partial and unavailable ones", () => {
    const available = createCapabilityProfile({
      backend: fixtureBackend,
      capabilities: {
        observe: { capability: "observe", status: "available" },
        click: { capability: "click", status: "available" },
      },
    })
    const partial = createCapabilityProfile({
      backend: fixtureBackend,
      capabilities: {
        observe: { capability: "observe", status: "available" },
        click: { capability: "click", status: "partial" },
      },
    })
    const unavailable = createUnavailableCapabilityProfile({ backend: fixtureBackend, reason: "No host." })
    expect(available.quality.overall).toBeGreaterThan(partial.quality.overall)
    expect(partial.quality.overall).toBeGreaterThan(unavailable.quality.overall)
    expect(unavailable.quality.overall).toBe(0)
  })

  test("permission denial makes affected capabilities unavailable", () => {
    const profile = createCapabilityProfile({
      backend: fixtureBackend,
      capabilities: {
        observe: { capability: "observe", status: "available" },
        screenshot: { capability: "screenshot", status: "available" },
      },
      permissions: [
        {
          id: "screen-recording",
          description: "Screen recording permission",
          status: "granted",
          capabilities: ["screenshot"],
          promptable: true,
        },
      ],
    })
    const denied = applyPermissionStatus(profile, { "screen-recording": "denied" })
    expect(denied.capabilities.screenshot?.status).toBe("unavailable")
    expect(denied.limitations.some((limitation) => limitation.code === "permission-denied")).toBe(true)
  })

  test("Wayland modeling downgrades global desktop capabilities", () => {
    const limitation: Limitation = {
      code: "fixture",
      kind: "platform",
      severity: "info",
      message: "Fixture limitation.",
      affects: [],
    }
    const profile = createCapabilityProfile({
      backend: fixtureBackend,
      displayServer: "wayland",
      capabilities: {
        observe: { capability: "observe", status: "available" },
        screenshot: { capability: "screenshot", status: "available" },
      },
      limitations: [limitation],
    })
    const wayland = applyWaylandLimitations(profile)
    expect(wayland.status).toBe("partial")
    expect(wayland.capabilities.screenshot?.status).toBe("partial")
    expect(wayland.permissions.some((permission) => permission.id === "wayland-portal")).toBe(true)
    expect(wayland.limitations.some((limitation) => limitation.code === "wayland-security-model")).toBe(true)
    const selected = selectBackend([profile], {
      platform: "linux",
      displayServer: "wayland",
      requestedCapabilities: ["screenshot"],
    })
    expect(selected.status).toBe("partial")
  })
  test("converts rich profiles to protocol capability contracts", () => {
    const support = toProtocolCapabilitySupport({
      capability: "observe",
      status: "partial",
      score: 0.5,
      permissions: [],
      limitations: [],
    })
    expect(support.status).toBe("degraded")
    const info = toProtocolComputerInfo(fixtureProfile)
    expect(info.backend).toBe(fixtureBackend.id)
    expect(info.capabilities?.some((capability) => capability.capability === "observe")).toBe(true)
  })

  test("bridges a protocol driver without inventing missing operations", async () => {
    const protocolDriver: ProtocolDriver = {
      id: "host-driver",
      backend: "host-driver",
      execute: async () => ({ success: true, status: "success" }),
    }
    const adapter = createAdapterFromProtocolDriver({
      backend: { ...fixtureBackend, id: "host-driver" },
      driver: protocolDriver,
      profile: { ...fixtureProfile, backend: { ...fixtureBackend, id: "host-driver" } },
    })
    const registry = new AdapterRegistry({ adapters: [adapter] })
    const driver = await registry.createDriver("host-driver")
    expect((await driver.execute({ type: "wait", ms: 1 })).status).toBe("success")
    expect((await driver.getCapabilities()).backend.id).toBe("host-driver")
  })
})

describe("backend selection", () => {
  test("ranks eligible backends and honors requested capabilities", () => {
    const browser = createCapabilityProfile({
      backend: {
        ...fixtureBackend,
        id: "browser-fixture",
        platform: "browser",
        kind: "browser",
        displayServers: ["browser"],
      },
      capabilities: {
        observe: { capability: "observe", status: "available" },
        "browser-dom": { capability: "browser-dom", status: "available" },
      },
    })
    const native = createCapabilityProfile({
      backend: fixtureBackend,
      capabilities: {
        observe: { capability: "observe", status: "available" },
        "browser-dom": { capability: "browser-dom", status: "partial" },
      },
    })
    const ranked = rankBackends([native, browser], {
      platform: "browser",
      requestedCapabilities: ["observe", "browser-dom"],
    })
    expect(ranked[0]?.profile.backend.id).toBe("browser-fixture")
    expect(ranked[0]?.eligible).toBe(true)
    expect(ranked[1]?.eligible).toBe(false)
  })

  test("returns partial when the best eligible backend is degraded", () => {
    const partial = createCapabilityProfile({
      backend: fixtureBackend,
      capabilities: {
        observe: { capability: "observe", status: "partial" },
      },
    })
    const selected = selectBackend([partial], { requestedCapabilities: ["observe"] })
    expect(selected.status).toBe("partial")
    if (selected.status === "partial") expect(selected.profile.backend.id).toBe(fixtureBackend.id)
  })

  test("returns unavailable when every backend lacks a required capability", () => {
    const result = selectBackend([fixtureProfile], { requestedCapabilities: ["keyboard"] })
    expect(result.status).toBe("unavailable")
    if (result.status === "unavailable") expect(result.reason).toContain("keyboard")
  })
})

describe("application capability profiles", () => {
  test("profiles and filters applications without inventing backend support", () => {
    const application = createApplicationProfile({
      id: "app-1",
      name: "Example",
      kind: "browser",
      backend: BACKEND_IDS.browser,
      capabilities: {
        "browser-dom": { capability: "browser-dom", status: "available" },
        screenshot: { capability: "screenshot", status: "partial" },
      },
    })
    expect(application.status).toBe("partial")
    expect(application.capabilities["browser-dom"]?.status).toBe("available")
    expect(application.capabilities.screenshot?.status).toBe("partial")
  })

  test("registry forwards application profiles from a host adapter", async () => {
    const application = createApplicationProfile({
      id: "app-1",
      name: "Example",
      backend: fixtureBackend.id,
      capabilities: { observe: { capability: "observe", status: "available" } },
    })
    const registry = new AdapterRegistry({ adapters: [fixtureAdapter(fixtureProfile, [application])] })
    expect(await registry.listApplications()).toEqual([application])
  })
})
