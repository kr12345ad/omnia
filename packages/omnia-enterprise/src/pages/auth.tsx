import { Show, createEffect, createResource, createSignal, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Mark } from "@opencode-ai/ui/logo"
import { api } from "@/lib/api"
import { navigate, routeQuery } from "@/lib/router"
import { setFavicon } from "@/lib/favicon"
import { useSession } from "@/state"
import { Button, Field, Input, InlineNote, Tag } from "@/components/ui"
import type { PublicConfig } from "@/types"
import "./auth.css"

function AuthFrame(props: {
  config?: PublicConfig
  title: string
  subtitle: string
  children: JSX.Element
  footer?: JSX.Element
}) {
  const name = () => props.config?.organization.name ?? "Omnia Enterprise"
  // Before sign-in there is no session, so the public config supplies the tab
  // mark; signing in hands the same job to the shell.
  createEffect(() => setFavicon(props.config?.branding.iconUrl || props.config?.branding.logoUrl))
  return (
    <div class="ent-auth">
      <aside class="ent-auth-aside">
        <div>
          <div class="ent-auth-brand">
            <span class="ent-brand-mark">
              <Mark square class="ent-brand-glyph" />
            </span>
            <span class="ent-auth-brand-text">
              <strong>Omnia</strong>
              <span>Enterprise console</span>
            </span>
          </div>
          <h2>Your AI workforce, on your infrastructure.</h2>
          <p>
            Distribute a client that is yours: your name, your models, your limits, and a single
            sign-in that only your people can use.
          </p>
          <div class="ent-auth-points">
            <div class="ent-auth-point">
              <span class="ent-auth-point-icon">
                <Icon name="shield" size="normal" />
              </span>
              <div>
                <strong>Single sign-on only</strong>
                <span>Shipped clients accept work email or employee ID. Social login is never included.</span>
              </div>
            </div>
            <div class="ent-auth-point">
              <span class="ent-auth-point-icon">
                <Icon name="server" size="normal" />
              </span>
              <div>
                <strong>Self-hosted control plane</strong>
                <span>Identity, policies, usage and audit records stay on hardware you control.</span>
              </div>
            </div>
            <div class="ent-auth-point">
              <span class="ent-auth-point-icon">
                <Icon name="review" size="normal" />
              </span>
              <div>
                <strong>Every decision recorded</strong>
                <span>Logins, role changes, policy edits and client releases are all in the audit trail.</span>
              </div>
            </div>
          </div>
        </div>
        <div class="ent-small ent-faint">
          {name()} · Enterprise {props.config?.version ?? "1.0.0"}
        </div>
      </aside>
      <main class="ent-auth-main">
        <div class="ent-auth-card">
          <Show
            when={props.config?.branding.logoUrl || props.config?.branding.iconUrl}
            fallback={
              <span class="ent-brand-mark ent-auth-card-mark">
                <Mark square class="ent-brand-glyph" />
              </span>
            }
          >
            {(url) => <img src={url()} alt="" style={{ height: "30px", "object-fit": "contain" }} />}
          </Show>
          <h1>{props.title}</h1>
          <p>{props.subtitle}</p>
          {props.children}
          <Show when={props.footer}>
            <div class="ent-auth-foot">{props.footer}</div>
          </Show>
        </div>
      </main>
    </div>
  )
}

export function usePublicConfig() {
  const [config] = createResource(async () => api.publicConfig().catch(() => undefined))
  return config
}

export function LoginPage() {
  const session = useSession()
  const config = usePublicConfig()
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: Event) => {
    event.preventDefault()
    if (email().trim().length === 0 || password().length === 0) {
      setError("Enter your work email address and password.")
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const next = await api.login({ email: email().trim(), password: password() })
      session.adopt(next)
      navigate("/overview")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame
      config={config()}
      title={config()?.branding.signInHeadline ?? "Sign in"}
      subtitle={config()?.branding.signInSubheadline ?? "Use your work email address and password."}
      footer={
        <Show when={!config()?.setupRequired}>
          <span>
            Single sign-on only. The console does not accept personal or social accounts. Contact your
            administrator if your account is locked.
          </span>
        </Show>
      }
    >
      <Show when={config()?.setupRequired}>
        <div class="ent-auth-notice">
          <InlineNote tone="warning" icon="warning">
            This deployment has no owner yet. Open the one-time setup link printed by{" "}
            <code>omnia-server init</code>.
          </InlineNote>
        </div>
      </Show>
      <form class="ent-auth-form" onSubmit={submit}>
        <Field label="Work email or employee ID" required>
          <Input
            value={email()}
            onInput={setEmail}
            placeholder="you@company.com"
            autocomplete="username"
            autofocus
          />
        </Field>
        <Field label="Password" required>
          <Input
            value={password()}
            onInput={setPassword}
            type="password"
            placeholder="••••••••••••"
            autocomplete="current-password"
          />
        </Field>
        <Show when={error()}>
          <InlineNote tone="danger" icon="warning">
            {error()}
          </InlineNote>
        </Show>
        <Button type="submit" variant="primary" loading={busy()}>
          Sign in
        </Button>
      </form>
      <Show when={config()?.setupRequired}>
        <div class="ent-auth-secondary">
          <Button variant="ghost" onClick={() => navigate("/setup")}>
            I have a setup link
          </Button>
        </div>
      </Show>
    </AuthFrame>
  )
}

export function SetupPage() {
  const session = useSession()
  const config = usePublicConfig()
  const token = routeQuery().get("token") ?? ""
  const [name, setName] = createSignal("")
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [confirm, setConfirm] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: Event) => {
    event.preventDefault()
    if (password() !== confirm()) {
      setError("The two passwords do not match.")
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const next = await api.setup({ token, email: email().trim(), name: name().trim(), password: password() })
      session.adopt(next)
      navigate("/overview")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Setup failed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame
      config={config()}
      title="Create the owner account"
      subtitle="This one-time link becomes the first owner of the deployment. It expires 24 hours after it was issued."
      footer="After setup, invite your team from People. This link cannot be reused."
    >
      <Show
        when={token.length > 0}
        fallback={
          <InlineNote tone="warning" icon="warning">
            This page needs the one-time token from <code>omnia-server init</code>. Run{" "}
            <code>omnia-server init --reset-setup</code> to issue another link.
          </InlineNote>
        }
      >
        <form class="ent-auth-form" onSubmit={submit}>
          <Field label="Your name" required>
            <Input value={name()} onInput={setName} placeholder="Ada Lovelace" autocomplete="name" />
          </Field>
          <Field label="Work email" required hint="This becomes the owner's sign-in name.">
            <Input
              value={email()}
              onInput={setEmail}
              placeholder="owner@company.com"
              autocomplete="username"
            />
          </Field>
          <Field label="Password" required hint="At least 12 characters. Stored with scrypt, never in plain text.">
            <Input value={password()} onInput={setPassword} type="password" autocomplete="new-password" />
          </Field>
          <Field label="Confirm password" required>
            <Input value={confirm()} onInput={setConfirm} type="password" autocomplete="new-password" />
          </Field>
          <Show when={error()}>
            <InlineNote tone="danger" icon="warning">
              {error()}
            </InlineNote>
          </Show>
          <Button type="submit" variant="primary" loading={busy()}>
            Create owner and continue
          </Button>
        </form>
      </Show>
    </AuthFrame>
  )
}

export function InvitePage() {
  const session = useSession()
  const config = usePublicConfig()
  const token = routeQuery().get("token") ?? ""
  const [name, setName] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [confirm, setConfirm] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: Event) => {
    event.preventDefault()
    if (password() !== confirm()) {
      setError("The two passwords do not match.")
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const next = await api.acceptInvite({ token, password: password(), ...(name().trim().length === 0 ? {} : { name: name() }) })
      session.adopt(next)
      navigate("/overview")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This invitation could not be accepted.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame
      config={config()}
      title="Set your password"
      subtitle="Your administrator created an Omnia account for you. Choose a password to finish joining."
      footer={
        <>
          <Tag tone="accent">Single sign-on</Tag>{" "}
          <span>This account only works with your organization's client.</span>
        </>
      }
    >
      <Show
        when={token.length > 0}
        fallback={
          <InlineNote tone="warning" icon="warning">
            This page needs the invitation token from your administrator's link.
          </InlineNote>
        }
      >
        <form class="ent-auth-form" onSubmit={submit}>
          <Field label="Your name">
            <Input value={name()} onInput={setName} placeholder="Ada Lovelace" autocomplete="name" />
          </Field>
          <Field label="Password" required hint="At least 12 characters.">
            <Input value={password()} onInput={setPassword} type="password" autocomplete="new-password" />
          </Field>
          <Field label="Confirm password" required>
            <Input value={confirm()} onInput={setConfirm} type="password" autocomplete="new-password" />
          </Field>
          <Show when={error()}>
            <InlineNote tone="danger" icon="warning">
              {error()}
            </InlineNote>
          </Show>
          <Button type="submit" variant="primary" loading={busy()}>
            Join {config()?.organization.name ?? "the workspace"}
          </Button>
        </form>
      </Show>
    </AuthFrame>
  )
}
