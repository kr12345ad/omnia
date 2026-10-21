import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { api } from "@/lib/api"
import { date, relative, titleCase } from "@/lib/format"
import { routeQuery } from "@/lib/router"
import { useSession, useToast } from "@/state"
import {
  Avatar,
  Button,
  Card,
  Checkbox,
  CopyField,
  EmptyState,
  Field,
  IconButton,
  InlineNote,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Stat,
  Tag,
} from "@/components/ui"
import type { Group, Invite, Role, Summary, User, UserStatus } from "@/types"
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/types"

const STATUS_TONE: Record<UserStatus, "success" | "warning" | "danger"> = {
  active: "success",
  invited: "warning",
  suspended: "danger",
}

const ROLE_OPTIONS: { value: Role; label: string }[] = (["owner", "admin", "manager", "member", "auditor", "billing"] as Role[]).map(
  (role) => ({ value: role, label: ROLE_LABELS[role] }),
)

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows
    .map((row) =>
      row
        .map((cell) => {
          const text = String(cell)
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
        })
        .join(","),
    )
    .join("\n")
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function UsersPage() {
  const session = useSession()
  const toast = useToast()
  const [users, setUsers] = createSignal<User[]>([])
  const [groups, setGroups] = createSignal<Group[]>([])
  const [invites, setInvites] = createSignal<Invite[]>([])
  const [summary, setSummary] = createSignal<Summary>()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const [appliedQuery, setAppliedQuery] = createSignal("")
  const [status, setStatus] = createSignal<"all" | UserStatus>("all")
  const [role, setRole] = createSignal<"all" | Role>("all")
  const [groupFilter, setGroupFilter] = createSignal(routeQuery().get("group") ?? "all")
  const [page, setPage] = createSignal(0)

  const [inviteOpen, setInviteOpen] = createSignal(false)
  const [inviteEmail, setInviteEmail] = createSignal("")
  const [inviteName, setInviteName] = createSignal("")
  const [inviteRole, setInviteRole] = createSignal<Role>("member")
  const [inviteGroups, setInviteGroups] = createSignal<string[]>([])
  const [inviteBusy, setInviteBusy] = createSignal(false)
  const [inviteError, setInviteError] = createSignal<string>()
  const [inviteLink, setInviteLink] = createSignal<string>()

  const [editing, setEditing] = createSignal<User>()
  const [editName, setEditName] = createSignal("")
  const [editTitle, setEditTitle] = createSignal("")
  const [editDepartment, setEditDepartment] = createSignal("")
  const [editEmployeeId, setEditEmployeeId] = createSignal("")
  const [editRole, setEditRole] = createSignal<Role>("member")
  const [editStatus, setEditStatus] = createSignal<UserStatus>("active")
  const [editGroups, setEditGroups] = createSignal<string[]>([])
  const [editMfa, setEditMfa] = createSignal(false)
  const [editBusy, setEditBusy] = createSignal(false)
  const [editError, setEditError] = createSignal<string>()

  const [resetLink, setResetLink] = createSignal<string>()
  const [resetName, setResetName] = createSignal("")
  const [pendingDelete, setPendingDelete] = createSignal<User>()
  const [deleteBusy, setDeleteBusy] = createSignal(false)

  let searchTimer: number | undefined

  const refresh = async () => {
    setLoading(true)
    setError(undefined)
    try {
      const collected: User[] = []
      let offset = 0
      for (let guard = 0; guard < 40; guard += 1) {
        const pageResult = await api.users({ limit: 500, offset })
        collected.push(...pageResult.users)
        if (collected.length >= pageResult.total || pageResult.users.length === 0) break
        offset += pageResult.users.length
      }
      setUsers(collected)
      const [groupResult, inviteResult, summaryResult] = await Promise.all([
        api.groups().catch(() => ({ ok: true as const, groups: [] })),
        api.invites().catch(() => ({ ok: true as const, invites: [] })),
        api.summary(30).catch(() => undefined),
      ])
      setGroups(groupResult.groups)
      setInvites(inviteResult.invites.filter((invite) => invite.purpose !== "reset" && invite.revokedAt === undefined && invite.acceptedAt === undefined))
      setSummary(summaryResult?.summary)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the directory.")
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void refresh()
    if (routeQuery().get("invite") === "1" && session.can("users:invite")) openInvite()
  })

  createEffect(() => {
    const text = query()
    if (searchTimer !== undefined) window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => setAppliedQuery(text.trim().toLowerCase()), 180)
  })

  createEffect(() => {
    query()
    status()
    role()
    groupFilter()
    setPage(0)
  })

  const filtered = createMemo(() => {
    const needle = appliedQuery()
    return users().filter((user) => {
      if (status() !== "all" && user.status !== status()) return false
      if (role() !== "all" && user.role !== role()) return false
      if (groupFilter() !== "all" && !user.groupIds.includes(groupFilter())) return false
      if (needle.length === 0) return true
      return (
        user.email.includes(needle) ||
        user.name.toLowerCase().includes(needle) ||
        (user.employeeId ?? "").toLowerCase().includes(needle) ||
        (user.department ?? "").toLowerCase().includes(needle)
      )
    })
  })

  const pageSize = 50
  const pageCount = createMemo(() => Math.max(1, Math.ceil(filtered().length / pageSize)))
  const pageUsers = createMemo(() => filtered().slice(page() * pageSize, page() * pageSize + pageSize))
  const counts = createMemo(() => ({
    total: users().length,
    active: users().filter((user) => user.status === "active").length,
    invited: users().filter((user) => user.status === "invited").length,
    suspended: users().filter((user) => user.status === "suspended").length,
  }))
  const groupName = (id: string) => groups().find((group) => group.id === id)?.name ?? id

  const openInvite = () => {
    setInviteEmail("")
    setInviteName("")
    setInviteRole("member")
    setInviteGroups([])
    setInviteError(undefined)
    setInviteLink(undefined)
    setInviteOpen(true)
  }

  const createInvite = async () => {
    setInviteBusy(true)
    setInviteError(undefined)
    try {
      const result = await api.invite({
        email: inviteEmail().trim(),
        ...(inviteName().trim().length === 0 ? {} : { name: inviteName().trim() }),
        role: inviteRole(),
        groupIds: inviteGroups(),
      })
      setInviteLink(result.url)
      toast.push("Invitation created. Copy the one-time link.", "success")
      void refresh()
    } catch (cause) {
      setInviteError(cause instanceof Error ? cause.message : "The invitation could not be created.")
    } finally {
      setInviteBusy(false)
    }
  }

  const submitInvite = (event: Event) => {
    event.preventDefault()
    void createInvite()
  }

  const openEdit = (user: User) => {
    setEditing(user)
    setEditName(user.name)
    setEditTitle(user.title ?? "")
    setEditDepartment(user.department ?? "")
    setEditEmployeeId(user.employeeId ?? "")
    setEditRole(user.role)
    setEditStatus(user.status)
    setEditGroups([...user.groupIds])
    setEditMfa(user.mfaEnabled)
    setEditError(undefined)
  }

  const saveEdit = async () => {
    const user = editing()
    if (user === undefined) return
    setEditBusy(true)
    setEditError(undefined)
    try {
      await api.updateUser(user.id, {
        name: editName().trim(),
        role: editRole(),
        status: editStatus(),
        groupIds: editGroups(),
        employeeId: editEmployeeId().trim(),
        title: editTitle().trim(),
        department: editDepartment().trim(),
        mfaEnabled: editMfa(),
      })
      setEditing(undefined)
      toast.push("Person updated.", "success")
      void refresh()
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : "The person could not be updated.")
    } finally {
      setEditBusy(false)
    }
  }

  const resetPassword = async (user: User) => {
    try {
      const result = await api.resetUser(user.id)
      setResetName(user.name)
      setResetLink(result.url)
      toast.push("One-time password link created.", "success")
    } catch (cause) {
      toast.push(cause instanceof Error ? cause.message : "Could not create a reset link.", "error")
    }
  }

  const remove = async () => {
    const user = pendingDelete()
    if (user === undefined) return
    setDeleteBusy(true)
    try {
      await api.deleteUser(user.id)
      setPendingDelete(undefined)
      setEditing(undefined)
      toast.push(`${user.name} was deleted. The action is in the audit log.`, "success")
      void refresh()
    } catch (cause) {
      toast.push(cause instanceof Error ? cause.message : "The person could not be deleted.", "error")
    } finally {
      setDeleteBusy(false)
    }
  }

  const exportDirectory = () => {
    downloadCsv(`omnia-people-${new Date().toISOString().slice(0, 10)}.csv`, [
      ["name", "email", "employee_id", "role", "status", "groups", "last_active", "seat"],
      ...filtered().map((user) => [
        user.name,
        user.email,
        user.employeeId ?? "",
        user.role,
        user.status,
        user.groupIds.map(groupName).join("; "),
        user.lastActiveAt === undefined ? "" : new Date(user.lastActiveAt).toISOString(),
        user.seat ? "yes" : "no",
      ]),
    ])
  }

  return (
    <div class="ent-page">
      <PageHeader
        kicker="Directory"
        title="People"
        description="Accounts that can sign in to your client. Enterprise builds use single sign-on with a work email or employee ID — personal and social accounts are not accepted."
        actions={
          <>
            <Button variant="secondary" icon="download" onClick={exportDirectory} disabled={users().length === 0}>
              Export
            </Button>
            <Show when={session.can("users:invite")}>
              <Button variant="primary" icon="plus" onClick={openInvite}>
                Invite people
              </Button>
            </Show>
          </>
        }
      />

      <div class="ent-grid ent-grid-4" style={{ "margin-bottom": "14px" }}>
        <Stat label="Accounts" value={counts().total} icon="users" hint={`${counts().active} active`} />
        <Stat
          label="Seats used"
          value={
            <span>
              {summary()?.seats.used ?? counts().active + counts().invited}
              <span class="ent-faint" style={{ "font-size": "15px", "font-weight": "500" }}>
                {" "}
                / {summary()?.seats.licensed ?? session.session()!.organization.license.seats}
              </span>
            </span>
          }
          icon="shield"
          hint={summary()?.seats.available === null ? "No hard cap" : `${summary()?.seats.available ?? 0} available`}
        />
        <Stat label="Pending invitations" value={counts().invited} icon="arrow-right" hint="Awaiting password setup" />
        <Stat label="Suspended" value={counts().suspended} icon="stop" hint="Cannot sign in" />
      </div>

      <Show when={error()}>
        <div style={{ "margin-bottom": "14px" }}>
          <InlineNote tone="danger" icon="warning">
            {error()} <Button size="small" variant="ghost" onClick={() => void refresh()}>Retry</Button>
          </InlineNote>
        </div>
      </Show>

      <Card padded={false}>
        <div class="ent-toolbar ent-directory-toolbar">
          <div class="ent-search">
            <Icon name="magnifying-glass" size="small" />
            <input
              class="ent-input"
              placeholder="Search people, email or employee ID"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              aria-label="Search people"
            />
          </div>
          <select class="ent-input ent-select" style={{ width: "140px" }} value={status()} onChange={(event) => setStatus(event.currentTarget.value as "all" | UserStatus)} aria-label="Filter by status">
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="invited">Invited</option>
            <option value="suspended">Suspended</option>
          </select>
          <select class="ent-input ent-select" style={{ width: "140px" }} value={role()} onChange={(event) => setRole(event.currentTarget.value as "all" | Role)} aria-label="Filter by role">
            <option value="all">All roles</option>
            <For each={ROLE_OPTIONS}>{(option) => <option value={option.value}>{option.label}</option>}</For>
          </select>
          <Show when={groups().length > 0}>
            <select class="ent-input ent-select" style={{ width: "150px" }} value={groupFilter()} onChange={(event) => setGroupFilter(event.currentTarget.value)} aria-label="Filter by group">
              <option value="all">All groups</option>
              <For each={groups()}>{(group) => <option value={group.id}>{group.name}</option>}</For>
            </select>
          </Show>
          <span class="ent-toolbar-count">
            {filtered().length} of {users().length}
          </span>
        </div>

        <Show when={loading()}>
          <div class="ent-stack" style={{ padding: "16px" }}>
            <Skeleton height={38} />
            <Skeleton height={38} />
            <Skeleton height={38} />
            <Skeleton height={38} />
          </div>
        </Show>

        <Show when={!loading() && filtered().length === 0}>
          <EmptyState
            icon="users"
            title={users().length === 0 ? "No people yet" : "No matches"}
            description={
              users().length === 0
                ? "Invite your first teammate. They will set a password through a one-time link; the client never offers social login."
                : "Try a different search, status or group. Filters are applied to the whole directory."
            }
            action={
              <>
                <Show when={users().length === 0 && session.can("users:invite")}>
                  <Button variant="primary" icon="plus" onClick={openInvite}>
                    Invite people
                  </Button>
                </Show>
                <Show when={users().length > 0}>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setQuery("")
                      setStatus("all")
                      setRole("all")
                      setGroupFilter("all")
                    }}
                  >
                    Clear filters
                  </Button>
                </Show>
              </>
            }
          />
        </Show>

        <Show when={!loading() && filtered().length > 0}>
          <div class="ent-table-wrap">
            <table class="ent-table ent-people-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Groups</th>
                  <th>Status</th>
                  <th>Last active</th>
                  <th data-align="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={pageUsers()}>
                  {(user) => (
                    <tr
                      class="ent-clickable-row"
                      onClick={() => openEdit(user)}
                      tabIndex={0}
                      aria-label={`Open ${user.name}`}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return
                        event.preventDefault()
                        openEdit(user)
                      }}
                    >
                      <td>
                        <div class="ent-user-cell">
                          <Avatar name={user.name} muted={user.status !== "active"} />
                          <span class="ent-user-cell-text">
                            <span class="ent-user-cell-name">{user.name}</span>
                            <span class="ent-user-cell-email">
                              {user.email}
                              <Show when={user.employeeId}>
                                <span class="ent-dot-sep" />
                                {user.employeeId}
                              </Show>
                            </span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <Tag tone={user.role === "owner" ? "accent" : "neutral"}>{ROLE_LABELS[user.role]}</Tag>
                      </td>
                      <td>
                        <Show
                          when={user.groupIds.length > 0}
                          fallback={<span class="ent-faint ent-small">Org defaults</span>}
                        >
                          <span class="ent-small ent-muted">
                            {groupName(user.groupIds[0]!)}
                            <Show when={user.groupIds.length > 1}>
                              <span class="ent-dot-sep" />+{user.groupIds.length - 1}
                            </Show>
                          </span>
                        </Show>
                      </td>
                      <td>
                        <Tag tone={STATUS_TONE[user.status]} dot>
                          {titleCase(user.status)}
                        </Tag>
                      </td>
                      <td class="ent-small ent-muted">{relative(user.lastActiveAt)}</td>
                      <td>
                        <div class="ent-row-actions" onClick={(event) => event.stopPropagation()}>
                          <Show when={session.can("users:write")}>
                            <IconButton icon="edit" label={`Edit ${user.name}`} onClick={() => openEdit(user)} />
                            <IconButton icon="copy" label={`Create a password link for ${user.name}`} onClick={() => void resetPassword(user)} />
                          </Show>
                          <Show when={session.can("users:write") && user.id !== session.session()!.user.id}>
                            <IconButton icon="trash" label={`Delete ${user.name}`} variant="danger" onClick={() => setPendingDelete(user)} />
                          </Show>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <div class="ent-pagination">
            <span>
              Showing {page() * pageSize + 1}–{Math.min(filtered().length, (page() + 1) * pageSize)} of {filtered().length}
            </span>
            <div class="ent-row" style={{ gap: "4px" }}>
              <Button size="small" variant="ghost" disabled={page() === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>
                Previous
              </Button>
              <span class="ent-mono ent-small" style={{ padding: "0 6px" }}>
                {page() + 1} / {pageCount()}
              </span>
              <Button
                size="small"
                variant="ghost"
                disabled={page() + 1 >= pageCount()}
                onClick={() => setPage((value) => Math.min(pageCount() - 1, value + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        </Show>
      </Card>

      <Show when={invites().length > 0}>
        <div style={{ "margin-top": "14px" }}>
          <Card title="Pending invitations" description="Links are single-use and expire after seven days. The raw link is only shown when it is created.">
            <div class="ent-list">
              <For each={invites()}>
                {(invite) => (
                  <div class="ent-list-row">
                    <span class="ent-auth-point-icon">
                      <Icon name="arrow-right" size="small" />
                    </span>
                    <span class="ent-list-row-main">
                      <span class="ent-list-row-title">{invite.email}</span>
                      <span class="ent-list-row-sub">
                        {ROLE_LABELS[invite.role]} · invited {date(invite.createdAt)} · expires {date(invite.expiresAt)}
                      </span>
                    </span>
                    <Show when={session.can("users:invite")}>
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await api.revokeInvite(invite.id)
                            toast.push("Invitation revoked.", "success")
                            void refresh()
                          } catch (cause) {
                            toast.push(cause instanceof Error ? cause.message : "Could not revoke the invitation.", "error")
                          }
                        }}
                      >
                        Revoke
                      </Button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Card>
        </div>
      </Show>

      <Modal
        open={inviteOpen()}
        onClose={() => setInviteOpen(false)}
        title="Invite people"
        description="They receive a single-use link, choose a password, and sign in with their work email or employee ID. There is no social sign-in."
        footer={
          <>
            <Button variant="ghost" onClick={() => setInviteOpen(false)}>
              Close
            </Button>
            <Show when={inviteLink() === undefined}>
              <Button variant="primary" loading={inviteBusy()} onClick={() => void createInvite()}>
                Create invitation
              </Button>
            </Show>
          </>
        }
      >
        <Show when={inviteLink() === undefined} fallback={<InvitationCreated url={inviteLink()!} email={inviteEmail()} onDone={() => setInviteOpen(false)} />}>
          <form class="ent-form-grid" onSubmit={submitInvite}>
            <Field label="Work email" required class="ent-span-2">
              <Input value={inviteEmail()} onInput={setInviteEmail} type="email" placeholder="teammate@company.com" autocomplete="off" />
            </Field>
            <Field label="Name" hint="Optional. They can change it when accepting.">
              <Input value={inviteName()} onInput={setInviteName} placeholder="Ada Lovelace" />
            </Field>
            <Field label="Role" hint={ROLE_DESCRIPTIONS[inviteRole()]}>
              <Select
                value={inviteRole()}
                onChange={setInviteRole}
                options={ROLE_OPTIONS.filter((option) => option.value !== "owner" || session.session()!.user.role === "owner")}
              />
            </Field>
            <Show when={groups().length > 0}>
              <div class="ent-span-2">
                <span class="ent-field-label">Groups</span>
                <div class="ent-grid ent-grid-2" style={{ gap: "0 16px", "margin-top": "4px" }}>
                  <For each={groups()}>
                    {(group) => (
                      <Checkbox
                        label={group.name}
                        description={group.modelAllowlist.length > 0 ? `${group.modelAllowlist.length} model${group.modelAllowlist.length === 1 ? "" : "s"} allowed` : "Inherits organization policy"}
                        checked={inviteGroups().includes(group.id)}
                        onChange={(checked) =>
                          setInviteGroups((current) => (checked ? [...current, group.id] : current.filter((id) => id !== group.id)))
                        }
                      />
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <Show when={inviteError()}>
              <div class="ent-span-2">
                <InlineNote tone="danger" icon="warning">
                  {inviteError()}
                </InlineNote>
              </div>
            </Show>
          </form>
        </Show>
      </Modal>

      <Modal
        open={editing() !== undefined}
        onClose={() => setEditing(undefined)}
        title={editing()?.name ?? "Edit person"}
        description={editing()?.email}
        width="wide"
        footer={
          <>
            <Show when={editing() !== undefined && editing()!.id !== session.session()!.user.id && session.can("users:write")}>
              <Button variant="ghost" onClick={() => setPendingDelete(editing())}>
                Delete
              </Button>
            </Show>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => setEditing(undefined)}>
              Cancel
            </Button>
            <Button variant="primary" loading={editBusy()} disabled={!session.can("users:write")} onClick={() => void saveEdit()}>
              Save changes
            </Button>
          </>
        }
      >
        <Show when={editing()}>
          {(user) => (
            <div class="ent-form-grid">
              <Field label="Name" required>
                <Input value={editName()} onInput={setEditName} disabled={!session.can("users:write")} />
              </Field>
              <Field label="Email" hint="Managed by the directory; SCIM can change it.">
                <Input value={user().email} readonly disabled />
              </Field>
              <Field label="Title">
                <Input value={editTitle()} onInput={setEditTitle} placeholder="Staff engineer" disabled={!session.can("users:write")} />
              </Field>
              <Field label="Department">
                <Input value={editDepartment()} onInput={setEditDepartment} placeholder="Platform" disabled={!session.can("users:write")} />
              </Field>
              <Field label="Employee ID" hint="People can sign in with this instead of their email.">
                <Input value={editEmployeeId()} onInput={setEditEmployeeId} placeholder="EMP-1042" disabled={!session.can("users:write")} />
              </Field>
              <Field label="Role" hint={ROLE_DESCRIPTIONS[editRole()]}>
                <Select value={editRole()} onChange={setEditRole} options={ROLE_OPTIONS} disabled={!session.can("users:write")} />
              </Field>
              <Field label="Status" hint="Suspending revokes every active session immediately.">
                <Select
                  value={editStatus()}
                  onChange={setEditStatus}
                  options={[
                    { value: "active", label: "Active" },
                    { value: "suspended", label: "Suspended" },
                    ...(user().status === "invited" ? [{ value: "invited" as UserStatus, label: "Invited (awaiting setup)" }] : []),
                  ]}
                  disabled={!session.can("users:write")}
                />
              </Field>
              <div>
                <span class="ent-field-label">Multi-factor authentication</span>
                <Checkbox
                  label="MFA completed at the identity provider"
                  description="Recorded here for audit and for your IdP's own reports. This server does not verify a second factor itself."
                  checked={editMfa()}
                  onChange={setEditMfa}
                  disabled={!session.can("users:write")}
                />
              </div>
              <div class="ent-span-2">
                <span class="ent-field-label">Groups</span>
                <div class="ent-grid ent-grid-2" style={{ gap: "0 16px", "margin-top": "4px" }}>
                  <For each={groups()}>
                    {(group) => (
                      <Checkbox
                        label={group.name}
                        description={group.description || "No description"}
                        checked={editGroups().includes(group.id)}
                        onChange={(checked) =>
                          setEditGroups((current) => (checked ? [...current, group.id] : current.filter((id) => id !== group.id)))
                        }
                        disabled={!session.can("users:write")}
                      />
                    )}
                  </For>
                  <Show when={groups().length === 0}>
                    <span class="ent-small ent-faint">No groups yet. Create one to apply model and spend limits.</span>
                  </Show>
                </div>
              </div>
              <Show when={editError()}>
                <div class="ent-span-2">
                  <InlineNote tone="danger" icon="warning">
                    {editError()}
                  </InlineNote>
                </div>
              </Show>
              <div class="ent-span-2">
                <Button
                  variant="secondary"
                  icon="copy"
                  disabled={!session.can("users:write")}
                  onClick={() => void resetPassword(user())}
                >
                  Create a one-time password link
                </Button>
              </div>
            </div>
          )}
        </Show>
      </Modal>

      <Modal
        open={resetLink() !== undefined}
        onClose={() => setResetLink(undefined)}
        title="One-time password link"
        description={`Send this to ${resetName()}. It expires in seven days and can be used once.`}
        footer={<Button variant="primary" onClick={() => setResetLink(undefined)}>Done</Button>}
      >
        <InlineNote tone="warning" icon="warning">
          The raw link is not stored and cannot be shown again. Anyone with it can choose a new password for this account.
        </InlineNote>
        <CopyField value={resetLink() ?? ""} />
      </Modal>

      <Modal
        open={pendingDelete() !== undefined}
        onClose={() => setPendingDelete(undefined)}
        title={`Delete ${pendingDelete()?.name ?? "person"}?`}
        description="This removes the account, its sessions and pending invitations. Usage history remains attributed to the person's ID."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(undefined)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleteBusy()} onClick={() => void remove()}>
              Delete person
            </Button>
          </>
        }
      >
        <InlineNote tone="danger" icon="warning">
          This is recorded in the audit log. Consider suspending the account instead if you may need it later.
        </InlineNote>
      </Modal>
    </div>
  )
}

function InvitationCreated(props: { url: string; email: string; onDone: () => void }) {
  return (
    <div class="ent-stack">
      <InlineNote tone="success" icon="check">
        Invitation created for {props.email}. Copy the link now — it is shown once and expires in seven days.
      </InlineNote>
      <CopyField value={props.url} />
      <div class="ent-row" style={{ "justify-content": "flex-end" }}>
        <Button variant="secondary" onClick={props.onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}
