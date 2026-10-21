import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { api } from "@/lib/api"
import { date, dateTime, plural, relative, until } from "@/lib/format"
import { useSession, useToast } from "@/state"
import {
  Avatar,
  Button,
  Card,
  Definition,
  Field,
  InlineNote,
  Input,
  PageHeader,
  Tag,
} from "@/components/ui"
import { ROLE_DESCRIPTIONS, ROLE_LABELS, type Capability } from "@/types"
import "./organization.css"

const PASSWORD_MIN = 12

export function AccountPage() {
  const session = useSession()
  const toast = useToast()
  const [groups] = createResource(async () => (await api.groups()).groups)
  const user = () => session.session()!.user

  const [current, setCurrent] = createSignal("")
  const [next, setNext] = createSignal("")
  const [confirm, setConfirm] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [done, setDone] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  const myGroups = createMemo(() => (groups() ?? []).filter((group) => user().groupIds.includes(group.id)))
  const capabilitiesByGroup = createMemo(() => {
    const grouped = new Map<string, Capability[]>()
    for (const capability of session.session()!.capabilities) {
      const prefix = capability.split(":")[0] ?? "other"
      const list = grouped.get(prefix) ?? []
      list.push(capability)
      grouped.set(prefix, list)
    }
    return [...grouped.entries()]
  })

  const submitPassword = async (event: Event) => {
    event.preventDefault()
    setDone(false)
    if (next().length < PASSWORD_MIN) {
      setError(`The new password must be at least ${PASSWORD_MIN} characters.`)
      return
    }
    if (next() !== confirm()) {
      setError("The two new passwords do not match.")
      return
    }
    if (next() === current()) {
      setError("Choose a password you have not used here before.")
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await api.changePassword({ currentPassword: current(), newPassword: next() })
      setCurrent("")
      setNext("")
      setConfirm("")
      setDone(true)
      toast.push("Password changed. Other console sessions were signed out.", "success")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the password.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="ent-page">
      <PageHeader
        kicker="Account"
        title="Your account"
        description="Your identity on this deployment. Access comes from your role; an administrator or SCIM directory controls everything else."
        actions={
          <>
            <Tag tone="accent">{ROLE_LABELS[user().role]}</Tag>
            <Button variant="secondary" onClick={() => void session.signOut()}>
              Sign out
            </Button>
          </>
        }
      />

      <div class="ent-split">
        <div class="ent-stack">
          <Card>
            <div class="org-identity-row">
              <Avatar name={user().name} />
              <div class="org-identity-text">
                <div class="org-identity-name">{user().name}</div>
                <div class="ent-small ent-faint">{user().email}</div>
                <div class="ent-row ent-wrap" style={{ "margin-top": "7px", gap: "5px" }}>
                  <Tag tone="accent">{ROLE_LABELS[user().role]}</Tag>
                  <Tag tone={user().status === "active" ? "success" : user().status === "suspended" ? "danger" : "warning"} dot>
                    {user().status}
                  </Tag>
                  <Show when={user().mfaEnabled}>
                    <Tag tone="success">MFA on file</Tag>
                  </Show>
                  <Show when={user().employeeId}>
                    <Tag tone="muted">ID {user().employeeId}</Tag>
                  </Show>
                </div>
              </div>
            </div>
            <div class="org-section-gap">
              <Definition label="Role">{ROLE_DESCRIPTIONS[user().role]}</Definition>
              <Definition label="Member since">{date(user().createdAt)}</Definition>
              <Definition label="Last active">{relative(user().lastActiveAt)}</Definition>
              <Definition label="Session expires">{until(session.session()!.session.expiresAt)}</Definition>
              <Definition label="Account updated">{dateTime(user().updatedAt)}</Definition>
            </div>
          </Card>

          <Card
            title="Change password"
            description="Changing it signs out every other console session for this account. The current session is reissued."
          >
            <form class="ent-stack" onSubmit={submitPassword}>
              <Field label="Current password" required>
                <Input
                  value={current()}
                  onInput={setCurrent}
                  type="password"
                  autocomplete="current-password"
                />
              </Field>
              <div class="ent-form-grid">
                <Field label="New password" required hint={`At least ${PASSWORD_MIN} characters.`}>
                  <Input value={next()} onInput={setNext} type="password" autocomplete="new-password" />
                </Field>
                <Field label="Confirm new password" required>
                  <Input value={confirm()} onInput={setConfirm} type="password" autocomplete="new-password" />
                </Field>
              </div>
              <Show when={error()}>
                <InlineNote tone="danger" icon="warning">
                  {error()}
                </InlineNote>
              </Show>
              <Show when={done()}>
                <InlineNote tone="success" icon="check">
                  Password changed. Other console sessions were signed out.
                </InlineNote>
              </Show>
              <div class="ent-row">
                <Button type="submit" variant="primary" loading={busy()}>
                  Change password
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setCurrent("")
                    setNext("")
                    setConfirm("")
                    setError(undefined)
                    setDone(false)
                  }}
                >
                  Clear
                </Button>
              </div>
            </form>
          </Card>

          <Card title="Profile" description="Managed by an administrator or your SCIM directory.">
            <div class="ent-form-grid">
              <Definition label="Employee ID">{user().employeeId ?? "—"}</Definition>
              <Definition label="Title">{user().title ?? "—"}</Definition>
              <Definition label="Department">{user().department ?? "—"}</Definition>
              <Definition label="External ID">
                <span class="ent-mono ent-small">{user().externalId ?? "—"}</span>
              </Definition>
            </div>
            <InlineNote icon="users">
              Your name, email, role and group membership are changed from{" "}
              <strong>Settings → People</strong> by someone with the right role. Ask an administrator if
              something is wrong.
            </InlineNote>
          </Card>
        </div>

        <div class="ent-stack org-rail">
          <Card title="Groups" description={plural(myGroups().length, "group")}>
            <Show
              when={groups() !== undefined}
              fallback={<div class="ent-skeleton" style={{ height: "70px" }} />}
            >
              <Show
                when={myGroups().length > 0}
                fallback={
                  <p class="ent-small ent-muted" style={{ margin: 0 }}>
                    You are not in a group. Group membership is optional and usually adds model or spend limits,
                    not extra access.
                  </p>
                }
              >
                <div class="ent-list">
                  <For each={myGroups()}>
                    {(group) => (
                      <div class="ent-list-row">
                        <span class="ent-user-cell-text">
                          <span class="ent-list-row-title">{group.name}</span>
                          <span class="ent-list-row-sub">
                            {group.description || "No description"}
                          </span>
                        </span>
                        <Tag tone="muted">{group.role}</Tag>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Card>

          <Card title="Your access" description={`${plural(session.session()!.capabilities.length, "capability", "capabilities")} from your role.`}>
            <div class="ent-stack">
              <For each={capabilitiesByGroup()}>
                {([group, list]) => (
                  <div>
                    <div class="ent-label" style={{ "margin-bottom": "5px" }}>
                      {group}
                    </div>
                    <div class="ent-row ent-wrap" style={{ gap: "4px" }}>
                      <For each={list}>{(capability) => <Tag tone="muted">{capability}</Tag>}</For>
                    </div>
                  </div>
                )}
              </For>
            </div>
            <Show when={!session.can("policies:write")}>
              <InlineNote icon="shield">
                Policy changes need an administrator. You can still read the policies that apply to you.
              </InlineNote>
            </Show>
          </Card>

          <div class="ent-danger-zone">
            <h3>Sign out</h3>
            <p>
              Ends this console session on this device. The client on your computer keeps its own enrollment
              token until an administrator revokes it.
            </p>
            <Button variant="danger" onClick={() => void session.signOut()}>
              Sign out of the console
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
