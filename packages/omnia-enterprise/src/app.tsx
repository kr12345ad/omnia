import { Match, Show, Switch, createEffect, type JSX } from "solid-js"
import { navigate, routePath } from "@/lib/router"
import { useSession } from "@/state"
import { AppShell } from "@/components/shell"
import { EmptyState } from "@/components/ui"
import { InvitePage, LoginPage, SetupPage } from "@/pages/auth"
import { OverviewPage } from "@/pages/overview"
import { UsersPage } from "@/pages/users"
import { GroupsPage } from "@/pages/groups"
import { DistributionsPage } from "@/pages/distributions"
import { DistributionEditorPage } from "@/pages/distribution-editor"
import { PoliciesPage } from "@/pages/policies"
import { UsagePage } from "@/pages/usage"
import { AuditPage } from "@/pages/audit"
import { IntegrationsPage } from "@/pages/integrations"
import { DeploymentPage } from "@/pages/deployment"
import { SettingsPage } from "@/pages/settings"
import { AccountPage } from "@/pages/account"
import type { Capability } from "@/types"

function BootScreen() {
  return (
    <div style={{ display: "grid", "place-items": "center", height: "100dvh", background: "var(--ent-bg)" }}>
      <div style={{ display: "flex", "flex-direction": "column", "align-items": "center", gap: "10px" }}>
        <span class="ent-spinner" style={{ width: "18px", height: "18px", color: "var(--ent-muted)" }} />
        <span class="ent-small ent-faint">Opening the enterprise console…</span>
      </div>
    </div>
  )
}

function Guard(props: { capability: Capability; children: JSX.Element }) {
  const session = useSession()
  return (
    <Show
      when={session.can(props.capability)}
      fallback={
        <EmptyState
          icon="shield"
          title="Your role cannot view this page"
          description={`You are signed in as ${session.session()?.user.role}. Ask an owner or administrator if you need access.`}
        />
      }
    >
      {props.children}
    </Show>
  )
}

export function App() {
  const session = useSession()

  createEffect(() => {
    const path = routePath()
    if (session.loading()) return
    if (
      session.session() !== null &&
      (path === "/login" || path === "/" || path.startsWith("/setup") || path.startsWith("/invite"))
    ) {
      navigate("/overview")
    }
  })

  return (
    <Switch>
      <Match when={routePath().startsWith("/setup")}>
        <SetupPage />
      </Match>
      <Match when={routePath().startsWith("/invite")}>
        <InvitePage />
      </Match>
      <Match when={session.loading()}>
        <BootScreen />
      </Match>
      <Match when={session.session() === null}>
        <LoginPage />
      </Match>
      <Match when={session.session() !== null}>
        <AppShell>
          <Switch fallback={<OverviewPage />}>
            <Match when={routePath() === "/overview" || routePath() === "/"}>
              <OverviewPage />
            </Match>
            <Match when={routePath().startsWith("/users")}>
              <Guard capability="users:read">
                <UsersPage />
              </Guard>
            </Match>
            <Match when={routePath().startsWith("/groups")}>
              <Guard capability="groups:read">
                <GroupsPage />
              </Guard>
            </Match>
            <Match when={routePath().startsWith("/distributions/")}>
              <Guard capability="distributions:read">
                <DistributionEditorPage />
              </Guard>
            </Match>
            <Match when={routePath().startsWith("/distributions")}>
              <Guard capability="distributions:read">
                <DistributionsPage />
              </Guard>
            </Match>
            <Match when={routePath().startsWith("/policies")}>
              <Guard capability="policies:read">
                <PoliciesPage />
              </Guard>
            </Match>
            <Match when={routePath().startsWith("/usage")}>
              <Guard capability="usage:read">
                <UsagePage />
              </Guard>
            </Match>
            <Match when={routePath().startsWith("/audit")}>
              <Guard capability="audit:read">
                <AuditPage />
              </Guard>
            </Match>
            <Match when={routePath().startsWith("/integrations")}>
              <Guard capability="integrations:read">
                <IntegrationsPage />
              </Guard>
            </Match>
            <Match when={routePath().startsWith("/deployment")}>
              <DeploymentPage />
            </Match>
            <Match when={routePath().startsWith("/settings")}>
              <SettingsPage />
            </Match>
            <Match when={routePath().startsWith("/account")}>
              <AccountPage />
            </Match>
          </Switch>
        </AppShell>
      </Match>
    </Switch>
  )
}
