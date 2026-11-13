import { expect, test, type Page } from "@playwright/test"

/**
 * Laptop acceptance for the mobile shell. These selectors are the contract the
 * slice must implement; they live in the UI so a reviewer can assert state
 * without reading the DOM by hand:
 *   [data-screen="pair" | "sessions" | "session"]
 *   [data-field="server-url" | "password" | "prompt"]
 *   [data-action="pair" | "send"]
 *   [data-conn-state="<FailureCode>"]   (packages/mobile/src/connection/fetch.ts)
 *   [data-session-id]                   (one per row in the session list)
 */
const SERVER_URL = process.env.ACCEPTANCE_SERVER_URL ?? "http://127.0.0.1:4097"
const PASSWORD = process.env.ACCEPTANCE_PASSWORD ?? "critic-pass"
const WRONG = "definitely-not-the-password"
const PHASE = process.env.ACCEPTANCE_PHASE ?? "pair"
const STATE = process.env.ACCEPTANCE_STATE ?? "e2e/mobile/.auth/pair.json"
const FOREIGN = process.env.ACCEPTANCE_FOREIGN_ORIGIN

async function pair(page: Page, server: string, password: string) {
  await expect(page.locator('[data-screen="pair"]')).toBeVisible()
  await page.locator('[data-field="server-url"]').fill(server)
  await page.locator('[data-field="password"]').fill(password)
  await page.locator('[data-action="pair"]').click()
}

test.describe("pairing", () => {
  test.use({ storageState: undefined })

  test("a wrong password is named unauthorized, not unreachable", async ({ page }) => {
    test.skip(PHASE !== "pair", "pairing phase only")
    await page.goto("/mobile.html")
    await pair(page, SERVER_URL, WRONG)
    await expect(page.locator('[data-conn-state="unauthorized"]')).toBeVisible()
    await expect(page.locator('[data-screen="sessions"]')).toHaveCount(0)
  })

  test("pairing reaches the session list and is remembered", async ({ page }) => {
    test.skip(PHASE !== "pair", "pairing phase only")
    await page.goto("/mobile.html")
    await pair(page, SERVER_URL, PASSWORD)
    await expect(page.locator('[data-screen="sessions"]')).toBeVisible()
    await page.context().storageState({ path: STATE })
  })
})

test.describe("offline recovery", () => {
  test.use({ storageState: PHASE === "offline" ? STATE : undefined })

  test("a dead host keeps the session list and never returns to Pair", async ({ page }) => {
    test.skip(PHASE !== "offline", "runs after the server is killed")
    await page.goto("/mobile.html")
    await expect(page.locator('[data-conn-state="host_offline"], [data-conn-state="unreachable"]')).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.locator('[data-screen="pair"]')).toHaveCount(0)
    await expect(page.locator('[data-screen="sessions"]')).toBeVisible()
  })
})

test.describe("foreign origin", () => {
  test.use({ storageState: undefined })

  test("a CORS-rejected origin is named cors_blocked, not unreachable", async ({ page }) => {
    test.skip(PHASE !== "cors", "cors phase only")
    test.skip(!FOREIGN, "set ACCEPTANCE_FOREIGN_ORIGIN")
    await page.goto(`${FOREIGN}/mobile.html`)
    await pair(page, SERVER_URL, PASSWORD)
    await expect(page.locator('[data-conn-state="cors_blocked"]')).toBeVisible()
  })
})

test.describe("prompting", () => {
  test.use({ storageState: PHASE === "prompt" ? STATE : undefined })

  test("opens a session and sends one prompt", async ({ page }) => {
    test.skip(PHASE !== "prompt", "prompt phase only")
    test.skip(process.env.ACCEPTANCE_MODEL !== "1", "host has no chat-runnable model")
    await page.goto("/mobile.html")
    await expect(page.locator('[data-screen="sessions"]')).toBeVisible()
    await page.locator("[data-session-id]").first().click()
    await expect(page.locator('[data-screen="session"]')).toBeVisible()
    await page.locator('[data-field="prompt"]').fill("acceptance ping")
    await page.locator('[data-action="send"]').click()
    await expect(page.locator('[data-message-role="user"]').last()).toContainText("acceptance ping")
  })
})
