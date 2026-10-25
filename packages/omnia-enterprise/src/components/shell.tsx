import { For, Show, createEffect, type ParentProps } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import type { IconProps } from "@opencode-ai/ui/icon"
import { Mark } from "@opencode-ai/ui/logo"
import { useSession } from "@/state"
import { href, navigate, routePath, routeSegments } from "@/lib/router"
import { plural } from "@/lib/format"
import { Avatar, Button, Tag } from "@/components/ui"
import { setFavicon } from "@/lib/favicon"
import type { Capability } from "@/types"

interface NavItem {
  label: string
  path: string
  icon: IconProps["name"]
  section: "Workspace" | "Governance" | "Organization"
  capability?: Capability
}

const NAV: NavItem[] = [
  { label: "Overview", path: "/overview", icon: "status", section: "Workspace" },
  { label: "People", path: "/users", icon: "users", section: "Workspace", capability: "users:read" },
  { label: "Groups", path: "/groups", icon: "group", section: "Workspace", capability: "groups:read" },
  { label: "Client builds", path: "/distributions", icon: "download", section: "Workspace", capability: "distributions:read" },
  { label: "Policies", path: "/policies", icon: "shield", section: "Governance", capability: "policies:read" },
  { label: "Usage & spend", path: "/usage", icon: "models", section: "Governance", capability: "usage:read" },
  { label: "Audit log", path: "/audit", icon: "review", section: "Governance", capability: "audit:read" },
  { label: "Integrations", path: "/integrations", icon: "link", section: "Organization", capability: "integrations:read" },
  { label: "Deployment", path: "/deployment", icon: "server", section: "Organization" },
  { label: "Settings", path: "/settings", icon: "sliders", section: "Organization" },
]

const SECTIONS = ["Workspace", "Governance", "Organization"] as const

function isActive(path: string): boolean {
  const current = routePath()
  if (path === "/overview") return current === "/overview" || current === "/"
  return current === path || current.startsWith(`${path}/`)
}

function pageTitle(): string {
  const segments = routeSegments()
  const root = `/${segments[0] ?? "overview"}`
  if (root === "/distributions" && segments[1] !== undefined) return "Client builder"
  if (root === "/account") return "Your account"
  return NAV.find((item) => item.path === root)?.label ?? "Overview"
}

export function AppShell(props: ParentProps) {
  const session = useSession()
  const user = () => session.session()!.user
  const org = () => session.session()!.organization
  // The rail is the console's own brand surface: an operator who set a mark
  // sees it here instead of the shipped glyph.
  const mark = () => org().branding.iconUrl || org().branding.logoUrl
  createEffect(() => setFavicon(mark()))
  const daysLeft = () => {
    const endsAt = org().trialEndsAt
    return Math.max(0, Math.ceil((endsAt - Date.now()) / 86_400_000))
  }
  const planTone = () => {
    const plan = org().plan
    if (plan === "expired") return "danger"
    if (plan === "trial") return "warning"
    return "success"
  }
  const planLabel = () => {
    const plan = org().plan
    if (plan === "trial") return `Trial · ${daysLeft()}d left`
    if (plan === "expired") return "Trial ended"
    return plan === "enterprise" ? "Enterprise" : "Business"
  }

  return (
    <div class="ent-shell">
      <aside class="ent-rail">
        <a class="ent-brand" href={href("/overview")} aria-label="Omnia Enterprise home">
          <Show
            when={mark()}
            fallback={
              <span class="ent-brand-mark">
                <Mark square class="ent-brand-glyph" />
              </span>
            }
          >
            {(url) => <img class="ent-brand-image" src={url()} alt="" />}
          </Show>
          <span class="ent-brand-text">
            <span class="ent-brand-name">Omnia</span>
            <span class="ent-brand-sub">Enterprise</span>
          </span>
        </a>

        <button type="button" class="ent-org-switcher" onClick={() => navigate("/settings")} title="Organization settings">
          <span class="ent-org-avatar">{org().name.slice(0, 2).toUpperCase()}</span>
          <span class="ent-org-name">{org().name}</span>
          <Icon name="chevron-down" size="small" />
        </button>

        <nav class="ent-nav" aria-label="Sections">
          <For each={SECTIONS}>
            {(section) => (
              <>
                <span class="ent-nav-section">{section}</span>
                <For each={NAV.filter((item) => item.section === section)}>
                  {(item) => (
                    <Show when={item.capability === undefined || session.can(item.capability)}>
                      <a class="ent-nav-item" href={href(item.path)} data-active={isActive(item.path) ? "" : undefined}>
                        <Icon name={item.icon} size="small" />
                        <span>{item.label}</span>
                      </a>
                    </Show>
                  )}
                </For>
              </>
            )}
          </For>
        </nav>

        <div class="ent-rail-foot">
          <div class="ent-plan-card">
            <div class="ent-plan-card-top">
              <span>Plan</span>
              <Tag tone={planTone()}>{planLabel()}</Tag>
            </div>
            <p>
              {org().plan === "trial"
                ? "Add a Business license to keep the console and client builds after the trial."
                : `${org().license.seats} seats licensed`}
            </p>
            <Button size="small" variant="secondary" onClick={() => navigate("/settings")}>
              {org().plan === "trial" ? "Add license" : "Manage plan"}
            </Button>
          </div>
          <button type="button" class="ent-user-chip" onClick={() => navigate("/account")}>
            <Avatar name={user().name} size="small" />
            <span class="ent-user-chip-text">
              <span class="ent-user-chip-name">{user().name}</span>
              <span class="ent-user-chip-email">{user().email}</span>
            </span>
            <Icon name="chevron-right" size="small" />
          </button>
        </div>
      </aside>

      <div class="ent-main">
        <header class="ent-topbar">
          <div class="ent-crumbs">
            <span class="ent-crumbs-org">{org().name}</span>
            <span class="ent-crumbs-sep">/</span>
            <strong>{pageTitle()}</strong>
          </div>
          <span class="ent-topbar-spacer" />
          <Show when={org().plan === "trial"}>
            <a href={href("/settings")} class="ent-status-pill" data-tone="warning" title="Trial status">
              <span class="ent-status-dot" />
              {plural(daysLeft(), "day")} left
            </a>
          </Show>
          <Show when={org().plan === "expired"}>
            <a href={href("/settings")} class="ent-status-pill" data-tone="danger">
              <span class="ent-status-dot" />
              License required
            </a>
          </Show>
          <span class="ent-status-pill ent-server-status" title="Server is reachable">
            <span class="ent-status-dot" />
            Server online
          </span>
          <a class="ent-account-link" href={href("/account")} aria-label="Your account">
            <Avatar name={user().name} size="small" />
            <span class="ent-account-label">Account</span>
          </a>
        </header>
        <main class="ent-content">{props.children}</main>
      </div>
    </div>
  )
}
