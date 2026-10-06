import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BINARY =
  process.env.OMNIA_E2E_BINARY ?? "/home/krishnaa/omnia/packages/desktop/dist/linux-unpacked/io.omnia.desktop"
const CONTROL_PLANE_STATE = process.env.OMNIA_E2E_STATE ?? "/home/krishnaa/omnia-host/state.json"
const HOME_HEADING = "What do you want to get done?"

function isolatedRoot(): string {
  return mkdtempSync(join(tmpdir(), "omnia-e2e-"))
}

function controlPlaneState(): { omniaToken: string; opencodePassword: string } | undefined {
  if (!existsSync(CONTROL_PLANE_STATE)) return undefined
  return JSON.parse(readFileSync(CONTROL_PLANE_STATE, "utf8")) as { omniaToken: string; opencodePassword: string }
}

async function launch(configHome: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: BINARY,
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY ?? ":0",
      XDG_CONFIG_HOME: configHome,
      OMNIA_DISABLE_UPDATES: "1",
    },
  })
}

async function stop(app: ElectronApplication, root: string): Promise<void> {
  await app.close().catch(() => undefined)
  rmSync(root, { recursive: true, force: true })
}

function seedSession(root: string, clientToken: string): void {
  const userData = join(root, "io.omnia.desktop")
  mkdirSync(userData, { recursive: true })
  // The loader accepts plaintext sessions (it only decrypts when `encrypted`
  // is set), so a seeded session needs no OS keychain access.
  writeFileSync(
    join(userData, "auth-session.json"),
    JSON.stringify({
      url: "https://openfoodpantry.org/test1/omnia",
      clientToken,
      profile: { id: 1, login: "e2e", name: "E2E" },
    }),
    { mode: 0o600 },
  )
}

test("first launch blocks on the required GitHub sign-in gate", async () => {
  const root = isolatedRoot()
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    const gate = page.locator('[data-component="first-run-gate"]')
    await expect(gate).toBeVisible()
    await expect(page.getByText("Sign in to Omnia")).toBeVisible()
    await expect(page.getByText("Continue with GitHub")).toBeVisible()
    // The app UI must not be usable before sign-in: the gate is the only root.
    await expect(page.locator("main")).toHaveCount(0)
    mkdirSync("artifacts", { recursive: true })
    await page.screenshot({ path: "artifacts/first-run-gate.png", fullPage: true })
  } finally {
    await stop(app, root)
  }
})

test("a stored session skips the gate and renders the app", async () => {
  const state = controlPlaneState()
  test.skip(state === undefined, "no hosted control-plane state on this machine")
  const root = isolatedRoot()
  seedSession(root, state!.omniaToken)
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await expect(page.locator('[data-component="first-run-gate"]')).toHaveCount(0)
    // A fresh profile shows the first-launch readiness card once the app
    // renders; its presence proves the gate was skipped and the UI mounted.
    await expect(page.getByText("Computer readiness")).toBeVisible()
    mkdirSync("artifacts", { recursive: true })
    await page.screenshot({ path: "artifacts/signed-in.png", fullPage: true })
  } finally {
    await stop(app, root)
  }
})

test("signed-in thin client reports the control-plane runtime as available", async () => {
  const state = controlPlaneState()
  test.skip(state === undefined, "no hosted control-plane state on this machine")
  const root = isolatedRoot()
  seedSession(root, state!.omniaToken)
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await expect(page.locator('[data-component="first-run-gate"]')).toHaveCount(0)
    // The app registers this machine's runtime on launch; poll until the
    // readiness call reports the control-plane computer as available.
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const api = (window as unknown as { api?: { omnia?: { getCapabilities: () => Promise<unknown> } } }).api
            if (api?.omnia === undefined) return undefined
            try {
              return (await api.omnia.getCapabilities()) as { ok?: boolean; value?: { available?: boolean } }
            } catch {
              return undefined
            }
          }),
        { timeout: 90_000, intervals: [3000] },
      )
      .toMatchObject({ ok: true, value: { available: true } })
    mkdirSync("artifacts", { recursive: true })
    await page.screenshot({ path: "artifacts/readiness.png", fullPage: true })
  } finally {
    await stop(app, root)
  }
})

test("hosted thin client loads through the tunnel with edge credentials", async ({ browser }) => {
  const state = controlPlaneState()
  test.skip(state === undefined, "no hosted control-plane state on this machine")
  const context = await browser.newContext({
    httpCredentials: { username: "opencode", password: state!.opencodePassword },
    viewport: { width: 1440, height: 900 },
  })
  try {
    const page = await context.newPage()
    await page.goto("https://openfoodpantry.org/test1/", { waitUntil: "domcontentloaded", timeout: 60_000 })
    await expect(page.getByText(HOME_HEADING)).toBeVisible({ timeout: 60_000 })
    // The gate is desktop-only: the hosted pages must not be blocked by it.
    await expect(page.locator('[data-component="first-run-gate"]')).toHaveCount(0)
    mkdirSync("artifacts", { recursive: true })
    await page.screenshot({ path: "artifacts/hosted-web.png", fullPage: true })
  } finally {
    await context.close()
  }
})
