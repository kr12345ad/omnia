import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { api } from "@/lib/api"
import { compact, number, usd } from "@/lib/format"
import { href } from "@/lib/router"
import { useSession, useToast } from "@/state"
import {
  Avatar,
  Button,
  Card,
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
  Textarea,
} from "@/components/ui"
import type { Group, Role, User } from "@/types"
import { ROLE_LABELS } from "@/types"

type GroupRole = Exclude<Role, "owner">

const ROLE_OPTIONS: { value: GroupRole; label: string }[] = (
  ["member", "manager", "auditor", "billing", "admin"] as GroupRole[]
).map((role) => ({ value: role, label: ROLE_LABELS[role] }))

function membersFor(users: User[], groupId: string): User[] {
  return users.filter((user) => user.groupIds.includes(groupId))
}

export function GroupsPage() {
  const session = useSession()
  const toast = useToast()
  const [groups, setGroups] = createSignal<Group[]>([])
  const [users, setUsers] = createSignal<User[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()

  const [editorOpen, setEditorOpen] = createSignal(false)
  const [editing, setEditing] = createSignal<Group>()
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [role, setRole] = createSignal<GroupRole>("member")
  const [models, setModels] = createSignal("")
  const [tokenLimit, setTokenLimit] = createSignal("")
  const [spendLimit, setSpendLimit] = createSignal("")
  const [computerLimit, setComputerLimit] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [formError, setFormError] = createSignal<string>()

  const [pendingDelete, setPendingDelete] = createSignal<Group>()
  const [deleteBusy, setDeleteBusy] = createSignal(false)

  const refresh = async () => {
    setLoading(true)
    setError(undefined)
    try {
      const [groupResult, collected] = await Promise.all([api.groups(), loadAllUsers()])
      setGroups(groupResult.groups)
      setUsers(collected)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load groups.")
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void refresh()
  })

  const stats = createMemo(() => {
    const assigned = new Set(users().flatMap((user) => user.groupIds))
    return {
      groups: groups().length,
      members: users().filter((user) => user.groupIds.length > 0).length,
      ungrouped: users().filter((user) => user.groupIds.length === 0).length,
      restricted: groups().filter((group) => group.modelAllowlist.length > 0).length,
      assignedGroups: assigned.size,
    }
  })

  const openCreate = () => {
    setEditing(undefined)
    setName("")
    setDescription("")
    setRole("member")
    setModels("")
    setTokenLimit("")
    setSpendLimit("")
    setComputerLimit("")
    setFormError(undefined)
    setEditorOpen(true)
  }

  const openEdit = (group: Group) => {
    setEditing(group)
    setName(group.name)
    setDescription(group.description)
    setRole(group.role)
    setModels(group.modelAllowlist.join(", "))
    setTokenLimit(group.monthlyTokenLimit === undefined ? "" : String(group.monthlyTokenLimit))
    setSpendLimit(group.monthlySpendLimitUsd === undefined ? "" : String(group.monthlySpendLimitUsd))
    setComputerLimit(group.maxComputers === undefined ? "" : String(group.maxComputers))
    setFormError(undefined)
    setEditorOpen(true)
  }

  const save = async () => {
    if (name().trim().length === 0) {
      setFormError("A group name is required.")
      return
    }
    setBusy(true)
    setFormError(undefined)
    const allowlist = models()
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
    const numeric = (value: string): number | undefined => {
      if (value.trim().length === 0) return undefined
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
    }
    const payload = {
      name: name().trim(),
      description: description().trim(),
      role: role(),
      modelAllowlist: allowlist,
      ...(numeric(tokenLimit()) === undefined ? {} : { monthlyTokenLimit: Math.floor(numeric(tokenLimit())!) }),
      ...(numeric(spendLimit()) === undefined ? {} : { monthlySpendLimitUsd: numeric(spendLimit())! }),
      ...(numeric(computerLimit()) === undefined ? {} : { maxComputers: Math.floor(numeric(computerLimit())!) }),
    }
    try {
      if (editing() === undefined) {
        await api.createGroup(payload)
        toast.push("Group created.", "success")
      } else {
        await api.updateGroup(editing()!.id, payload)
        toast.push("Group updated.", "success")
      }
      setEditorOpen(false)
      void refresh()
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The group could not be saved.")
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const group = pendingDelete()
    if (group === undefined) return
    setDeleteBusy(true)
    try {
      await api.deleteGroup(group.id)
      setPendingDelete(undefined)
      toast.push(`${group.name} was deleted. Members fall back to organization limits.`, "success")
      void refresh()
    } catch (cause) {
      toast.push(cause instanceof Error ? cause.message : "The group could not be deleted.", "error")
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div class="ent-page">
      <PageHeader
        kicker="Directory"
        title="Groups"
        description="Groups apply team-level model access and spend limits on top of the organization policy. A person can belong to several groups; the tightest limit wins."
        actions={
          <Show when={session.can("groups:write")}>
            <Button variant="primary" icon="plus" onClick={openCreate}>
              New group
            </Button>
          </Show>
        }
      />

      <div class="ent-grid ent-grid-4" style={{ "margin-bottom": "14px" }}>
        <Stat label="Groups" value={stats().groups} icon="group" hint={`${stats().assignedGroups} in use`} />
        <Stat label="Grouped people" value={stats().members} icon="users" hint={`${stats().ungrouped} use org defaults`} />
        <Stat label="Model-restricted" value={stats().restricted} icon="models" hint="Explicit allowlists" />
        <Stat
          label="Ungrouped"
          value={stats().ungrouped}
          icon="warning"
          hint={stats().ungrouped > 0 ? "They follow the organization policy" : "Everyone has a group"}
        />
      </div>

      <Show when={error()}>
        <div style={{ "margin-bottom": "14px" }}>
          <InlineNote tone="danger" icon="warning">
            {error()} <Button size="small" variant="ghost" onClick={() => void refresh()}>Retry</Button>
          </InlineNote>
        </div>
      </Show>

      <Show when={loading()}>
        <Card>
          <div class="ent-stack">
            <Skeleton height={40} />
            <Skeleton height={40} />
            <Skeleton height={40} />
          </div>
        </Card>
      </Show>

      <Show when={!loading() && groups().length === 0}>
        <Card>
          <EmptyState
            icon="group"
            title="No groups yet"
            description="Create a group for each team that needs its own model allowlist, token budget or spend cap. People without a group follow the organization policy."
            action={
              <Show when={session.can("groups:write")}>
                <Button variant="primary" icon="plus" onClick={openCreate}>
                  New group
                </Button>
              </Show>
            }
          />
        </Card>
      </Show>

      <Show when={!loading() && groups().length > 0}>
        <Card padded={false}>
          <div class="ent-table-wrap">
            <table class="ent-table ent-groups-table">
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Role</th>
                  <th data-align="right">Members</th>
                  <th>Model access</th>
                  <th data-align="right">Monthly tokens</th>
                  <th data-align="right">Spend cap</th>
                  <th data-align="right">Computers</th>
                  <th data-align="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={groups()}>
                  {(group) => {
                    const members = () => membersFor(users(), group.id)
                    return (
                      <tr>
                        <td>
                          <div class="ent-user-cell">
                            <span class="ent-org-avatar">{group.name.slice(0, 2).toUpperCase()}</span>
                            <span class="ent-user-cell-text">
                              <span class="ent-user-cell-name">{group.name}</span>
                              <span class="ent-user-cell-email">
                                {group.description || "No description"}
                              </span>
                            </span>
                          </div>
                        </td>
                        <td>
                          <Tag tone="neutral">{ROLE_LABELS[group.role]}</Tag>
                        </td>
                        <td data-align="right">
                          <a
                            class="ent-group-members"
                            href={href(`/users?group=${encodeURIComponent(group.id)}`)}
                            title={`Open ${members().length} member${members().length === 1 ? "" : "s"} in People`}
                          >
                            {members().length}
                            <span>{members().length === 1 ? "person" : "people"}</span>
                          </a>
                        </td>
                        <td>
                          <Show
                            when={group.modelAllowlist.length > 0}
                            fallback={<span class="ent-small ent-faint">Org policy</span>}
                          >
                            <span class="ent-small ent-muted ent-truncate" style={{ "max-width": "190px", display: "block" }}>
                              {group.modelAllowlist.slice(0, 2).join(", ")}
                              <Show when={group.modelAllowlist.length > 2}> +{group.modelAllowlist.length - 2}</Show>
                            </span>
                          </Show>
                        </td>
                        <td data-align="right" class="ent-num">
                          {group.monthlyTokenLimit === undefined ? "—" : compact(group.monthlyTokenLimit)}
                        </td>
                        <td data-align="right" class="ent-num">
                          {group.monthlySpendLimitUsd === undefined ? "—" : usd(group.monthlySpendLimitUsd, 0)}
                        </td>
                        <td data-align="right">
                          <Show
                            when={group.maxComputers !== undefined}
                            fallback={<span class="ent-small ent-faint">Org policy</span>}
                          >
                            <span class="ent-num">{number(group.maxComputers!)}</span>
                          </Show>
                        </td>
                        <td>
                          <div class="ent-row-actions">
                            <Show when={session.can("groups:write")}>
                              <IconButton icon="edit" label={`Edit ${group.name}`} onClick={() => openEdit(group)} />
                              <IconButton
                                icon="trash"
                                label={`Delete ${group.name}`}
                                variant="danger"
                                onClick={() => setPendingDelete(group)}
                              />
                            </Show>
                          </div>
                        </td>
                      </tr>
                    )
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Card>
      </Show>

      <Show when={!loading()}>
        <div style={{ "margin-top": "14px" }}>
          <Card title="How group limits resolve" description="Predictable precedence, checked in this order.">
            <div class="ent-list">
              <div class="ent-list-row">
                <span class="ent-auth-point-icon">
                  <Icon name="shield" size="small" />
                </span>
                <span class="ent-list-row-main">
                  <span class="ent-list-row-title">Organization policy is the floor</span>
                  <span class="ent-list-row-sub">
                    No group can grant a tool, model or data permission the organization has disabled.
                  </span>
                </span>
              </div>
              <div class="ent-list-row">
                <span class="ent-auth-point-icon">
                  <Icon name="models" size="small" />
                </span>
                <span class="ent-list-row-main">
                  <span class="ent-list-row-title">Model allowlists intersect</span>
                  <span class="ent-list-row-sub">
                    A person in two groups can use only the models allowed by both. An empty list inherits the organization.
                  </span>
                </span>
              </div>
              <div class="ent-list-row">
                <span class="ent-auth-point-icon">
                  <Icon name="dash" size="small" />
                </span>
                <span class="ent-list-row-main">
                  <span class="ent-list-row-title">Budgets take the lowest cap</span>
                  <span class="ent-list-row-sub">
                    Token and spend limits are per person per month; the tightest group limit applies.
                  </span>
                </span>
              </div>
            </div>
          </Card>
        </div>
      </Show>

      <Modal
        open={editorOpen()}
        onClose={() => setEditorOpen(false)}
        title={editing() === undefined ? "New group" : `Edit ${editing()!.name}`}
        description="Limits apply to every member. Leave a field empty to inherit the organization policy."
        width="wide"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy()} onClick={() => void save()}>
              {editing() === undefined ? "Create group" : "Save group"}
            </Button>
          </>
        }
      >
        <div class="ent-form-grid">
          <Field label="Name" required>
            <Input value={name()} onInput={setName} placeholder="Platform engineering" />
          </Field>
          <Field label="Default role" hint="Applied as a suggested role for new members; it does not change existing roles.">
            <Select value={role()} onChange={setRole} options={ROLE_OPTIONS} />
          </Field>
          <Field label="Description" class="ent-span-2">
            <Input value={description()} onInput={setDescription} placeholder="Owns the build and deploy pipeline" />
          </Field>
          <Field
            label="Model allowlist"
            class="ent-span-2"
            hint="Comma or newline separated model IDs. Empty means the organization's model policy applies."
          >
            <Textarea
              value={models()}
              onInput={setModels}
              rows={3}
              placeholder="anthropic/claude-sonnet-4-5, openai/gpt-5"
            />
          </Field>
          <Field label="Monthly tokens per person" hint="Leave empty to inherit. 0 blocks model use.">
            <Input value={tokenLimit()} onInput={setTokenLimit} type="number" min={0} placeholder="5000000" />
          </Field>
          <Field label="Monthly spend per person (USD)" hint="Leave empty to inherit. 0 blocks paid usage.">
            <Input value={spendLimit()} onInput={setSpendLimit} type="number" min={0} step={1} placeholder="150" />
          </Field>
          <Field label="Max computers per person" hint="Leave empty to inherit.">
            <Input value={computerLimit()} onInput={setComputerLimit} type="number" min={1} placeholder="5" />
          </Field>
          <div>
            <span class="ent-field-label">Members</span>
            <p class="ent-small ent-faint" style={{ margin: "4px 0 0" }}>
              {editing() === undefined
                ? "Add people after creating the group."
                : `${membersFor(users(), editing()!.id).length} people belong to this group.`}
            </p>
            <Show when={editing() !== undefined && membersFor(users(), editing()!.id).length > 0}>
              <div class="ent-row ent-wrap" style={{ "margin-top": "8px", gap: "4px" }}>
                <For each={membersFor(users(), editing()!.id).slice(0, 6)}>
                  {(member) => (
                    <Tag tone="muted">
                      <Avatar name={member.name} size="small" />
                      {member.name}
                    </Tag>
                  )}
                </For>
                <Show when={membersFor(users(), editing()!.id).length > 6}>
                  <Tag tone="muted">+{membersFor(users(), editing()!.id).length - 6}</Tag>
                </Show>
              </div>
            </Show>
          </div>
          <Show when={formError()}>
            <div class="ent-span-2">
              <InlineNote tone="danger" icon="warning">
                {formError()}
              </InlineNote>
            </div>
          </Show>
        </div>
      </Modal>

      <Modal
        open={pendingDelete() !== undefined}
        onClose={() => setPendingDelete(undefined)}
        title={`Delete ${pendingDelete()?.name ?? "group"}?`}
        description="Members lose this group's model allowlist and budgets. Their accounts remain active and fall back to the organization policy."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(undefined)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleteBusy()} onClick={() => void remove()}>
              Delete group
            </Button>
          </>
        }
      >
        <InlineNote tone="warning" icon="warning">
          The deletion is recorded in the audit log. This cannot be undone.
        </InlineNote>
      </Modal>
    </div>
  )
}

async function loadAllUsers(): Promise<User[]> {
  const collected: User[] = []
  let offset = 0
  for (let guard = 0; guard < 40; guard += 1) {
    const result = await api.users({ limit: 500, offset })
    collected.push(...result.users)
    if (collected.length >= result.total || result.users.length === 0) break
    offset += result.users.length
  }
  return collected
}
