import { existsSync, readdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { app } from "electron"
import { getStore } from "./store"
import { FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY, OLD_LAYOUT_ELIGIBLE_KEY } from "./store-keys"
import { write as writeLog } from "./logging"
import { hasExistingAppState } from "./install-state"

const DEFAULT_PROJECT_DIR = "Default Project"

export function initializeOldLayoutEligibility(userDataPath: string) {
  const store = getStore()
  const current = store.get(OLD_LAYOUT_ELIGIBLE_KEY)
  if (typeof current === "boolean") return current

  // This runs at startup before anything else; an unreadable data directory
  // must not throw here and take the whole app down with it. Leaving the key
  // unset keeps the decision for the next launch instead of treating a
  // returning user as a new install.
  const entries = readUserDataEntries(userDataPath)
  if (!entries) return false

  const eligible = hasExistingAppState(entries)
  store.set(OLD_LAYOUT_ELIGIBLE_KEY, eligible)
  return eligible
}

function readUserDataEntries(userDataPath: string) {
  if (!existsSync(userDataPath)) return []
  try {
    return readdirSync(userDataPath, { withFileTypes: true })
  } catch (error) {
    writeLog("onboarding", "failed to read user data directory", { userDataPath, error }, "warn")
    return undefined
  }
}

export function isOldLayoutEligible() {
  return getStore().get(OLD_LAYOUT_ELIGIBLE_KEY) === true
}

export function isFirstLaunchOnboardingPending() {
  const pending = getStore().get(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY) !== true
  writeLog("onboarding", "first launch onboarding pending checked", { pending })
  return pending
}

export async function finishFirstLaunchOnboarding(createDefaultProject: boolean) {
  if (!isFirstLaunchOnboardingPending()) {
    writeLog("onboarding", "first launch onboarding already completed")
    return null
  }

  // macOS TCC protects ~/Documents, so a freshly installed app cannot create
  // the default project there without a folder-permission prompt. The home
  // directory is not protected and always writable.
  const defaultProject = createDefaultProject
    ? process.platform === "darwin"
      ? join(app.getPath("home"), "OmniaProjects", "Default")
      : join(app.getPath("documents"), DEFAULT_PROJECT_DIR)
    : null
  if (defaultProject) await mkdir(defaultProject, { recursive: true })

  getStore().set(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY, true)
  writeLog("onboarding", "first launch onboarding completed", { createDefaultProject, defaultProject })
  return defaultProject
}
