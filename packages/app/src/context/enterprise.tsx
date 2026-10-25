import { Show, createEffect, createResource, onCleanup } from "solid-js"
import { Link } from "@solidjs/meta"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { usePlatform, type EnterprisePermissions, type EnterprisePolicy } from "./platform"
import { normalizeLocale, useLanguage } from "./language"
import { GITHUB_AUTH_CHANGED_EVENT } from "@/components/github-auth"
import { managedFeatureGranted } from "@/utils/enterprise-features"

/**
 * The admin's manifest, resolved by the main process (baked profile underneath,
 * live manifest over it). Outside a managed build this is inert: policy stays
 * undefined and every switch reads as unrestricted, so the public app cannot
 * change behavior through this context.
 */
export const { use: useEnterprise, provider: EnterpriseProvider } = createSimpleContext({
  name: "Enterprise",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const enterprise = platform.auth?.enterprise
    const managed = enterprise?.managed === true
    const [policy, { refetch }] = createResource(async () => {
      if (!managed) return undefined
      try {
        return await enterprise.policy()
      } catch {
        return undefined
      }
    })

    const refresh = () => void refetch()
    if (typeof window !== "undefined") {
      window.addEventListener(GITHUB_AUTH_CHANGED_EVENT, refresh)
      onCleanup(() => window.removeEventListener(GITHUB_AUTH_CHANGED_EVENT, refresh))
    }

    const active = () => (managed ? policy() : undefined)
    const feature = (name: string) => active()?.features[name] !== false
    // A capability the admin must grant; absent means the build never opted in.
    // A managed build with no policy yet grants nothing: the renderer mounts
    // before the manifest resolves, and that window must not leak a surface the
    // admin never switched on. An unmanaged build keeps every surface.
    const granted = (name: string) => (managed ? managedFeatureGranted(active()?.features, name) : true)
    // Tool rules are separate from the capability switches: an admin can keep
    // shell on but require approval, or deny it without touching the switch.
    const permission = (name: keyof EnterprisePermissions) => active()?.permissions?.[name] ?? "allow"

    const modelKey = (providerID: string, modelID: string) => `${providerID}/${modelID}`
    // An empty allowlist means every model the organization policy allows; an
    // entry on the blocklist always wins.
    const modelPermitted = (providerID: string, modelID: string) => {
      const models = active()?.models
      if (models === undefined) return true
      const key = modelKey(providerID, modelID)
      if (models.blocked.some((entry) => entry === key)) return false
      if (models.allowed.length === 0) return true
      return models.allowed.some((entry) => entry === key)
    }

    // File attachments: off hides every picker, and the size ceiling rejects
    // oversize files with a message. A ceiling of 0 means unlimited, matching
    // the console. Outside a managed build everything is allowed.
    const attachmentCheck = (file: { name: string; size: number }) => {
      const policyValue = active()
      if (policyValue === undefined) return undefined
      if (policyValue.features.fileAttachments === false)
        return "File attachments are turned off for this client."
      const cap = policyValue.limits.maxFileUploadMb
      if (cap > 0 && file.size > cap * 1024 * 1024)
        return `${file.name} exceeds the ${cap} MB limit for this client.`
      return undefined
    }

    return {
      /** True only for an installer produced for an organization. */
      managed,
      attachmentCheck,
      /** The resolved admin policy; undefined while loading or outside a managed build. */
      policy: active,
      /** A capability switch. Unrestricted unless the policy turns it off. */
      feature,
      /** A capability that must be granted explicitly; off when absent. */
      granted,
      /** A tool rule; `allow` when the policy does not name one. */
      permission,
      modelPermitted,
      branding: () => active()?.branding,
      auth: () => active()?.auth,
      experience: () => active()?.experience,
      limits: () => active()?.limits,
      models: () => active()?.models,
      telemetry: () => active()?.telemetry,
      update: () => active()?.update,
      refresh,
    }
  },
})

export type { EnterprisePolicy }

function storedThemeScheme(): string | null {
  try {
    return localStorage.getItem("opencode-color-scheme")
  } catch {
    return null
  }
}

function storedLocale(): string | null {
  try {
    const raw = localStorage.getItem("opencode.global.dat:language")
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    const locale = (parsed as { locale?: unknown }).locale
    return typeof locale === "string" ? locale : null
  } catch {
    return null
  }
}

/**
 * Applies the admin's first-launch experience. Theme and language seed a fresh
 * profile once and never overwrite a person's own choice; density rides the
 * document so compact fleets stay compact on every launch.
 */
/**
 * The browser tab carries the admin's mark. index.html ships the Omnia favicon,
 * so a branded deployment adds its own icon link on top of it; a deployment
 * without branding adds nothing and keeps the default.
 */
export function EnterpriseFavicon() {
  const policy = useEnterprise()
  const icon = () => policy.policy()?.branding.iconUrl || policy.policy()?.branding.logoUrl
  return <Show when={icon()}>{(url) => <Link rel="icon" href={url()} />}</Show>
}

export function EnterpriseExperience() {
  const policy = useEnterprise()
  const theme = useTheme()
  const language = useLanguage()

  createEffect(() => {
    const experience = policy.policy()?.experience
    if (!policy.managed || experience === undefined) return
    if ((experience.theme === "light" || experience.theme === "dark") && storedThemeScheme() === null) {
      theme.setColorScheme(experience.theme)
    }
    if (
      (experience.locale === "en" || experience.locale === "de" || experience.locale === "ar") &&
      storedLocale() === null
    ) {
      language.setLocale(normalizeLocale(experience.locale))
    }
    document.documentElement.dataset.density = experience.density
  })

  return null
}
