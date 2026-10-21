import { For, Show, createMemo, createResource } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { api } from "@/lib/api"
import { date, dateTime, plural } from "@/lib/format"
import { href } from "@/lib/router"
import { useSession } from "@/state"
import {
  Button,
  Card,
  CopyField,
  Definition,
  EmptyState,
  InlineNote,
  PageHeader,
  Stat,
  Tag,
} from "@/components/ui"
import "./organization.css"

const CADDY = `enterprise.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8787
}`

const NGINX = `server {
  listen 443 ssl http2;
  server_name enterprise.example.com;

  ssl_certificate     /etc/ssl/enterprise.pem;
  ssl_certificate_key /etc/ssl/enterprise.key;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}`

const SYSTEMD = `[Unit]
Description=Omnia Enterprise
After=network.target

[Service]
Type=simple
User=omnia
ExecStart=/opt/omnia/omnia-server start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target`

function CodeBlock(props: { code: string; label: string }) {
  return (
    <div>
      <div class="ent-label org-code-label">{props.label}</div>
      <pre class="org-code-block">{props.code}</pre>
    </div>
  )
}

export function DeploymentPage() {
  const session = useSession()
  const [config] = createResource(async () => api.publicConfig().catch(() => undefined))
  const [distributions] = createResource(async () => (await api.distributions()).distributions)
  const origin = () => window.location.origin
  const published = createMemo(() => (distributions() ?? []).filter((build) => build.status === "published"))
  const online = () => config() !== undefined

  return (
    <div class="ent-page">
      <PageHeader
        kicker="Operations"
        title="Deployment"
        description="This control plane is the source of truth: identity, client builds, policies, usage and audit records all live on this server."
        actions={
          <Button variant="secondary" icon="copy" onClick={() => void navigator.clipboard.writeText(`${origin()}/admin`)}>
            Copy console URL
          </Button>
        }
      />

      <div class="ent-grid ent-grid-4" style={{ "margin-bottom": "14px" }}>
        <Stat label="Console" value={<span class="ent-mono" style={{ "font-size": "14px" }}>/admin</span>} icon="console" hint={origin()} />
        <Stat
          label="Version"
          value={config()?.version ?? "—"}
          icon="server"
          hint={config() ? "Enterprise server" : "Check that omnia-server is running"}
        />
        <Stat label="API base" value={<span class="ent-mono" style={{ "font-size": "14px" }}>/v1/enterprise</span>} icon="terminal" />
        <Stat
          label="Published builds"
          value={distributions() === undefined ? "—" : String(published().length)}
          icon="download"
          hint={distributions() === undefined ? undefined : plural(distributions()!.length, "build") + " total"}
        />
      </div>

      <Show when={!online()}>
        <div style={{ "margin-bottom": "14px" }}>
          <InlineNote tone="danger" icon="warning">
            The public health endpoint did not answer. The reverse proxy may be down, or the process is not
            running. Check <code>omnia-server status</code> and the service logs.
          </InlineNote>
        </div>
      </Show>

      <div class="ent-split">
        <div class="ent-stack">
          <Card
            title="Client enrollment"
            description="Published builds expose an enrollment bundle per platform. The bundle pins the client to this server and this build."
            actions={
              <Button size="small" variant="ghost" onClick={() => window.location.assign(href("/distributions"))}>
                Manage builds
              </Button>
            }
          >
            <Show
              when={distributions() !== undefined}
              fallback={<div class="ent-skeleton" style={{ height: "160px" }} />}
            >
              <Show
                when={published().length > 0}
                fallback={
                  <EmptyState
                    compact
                    icon="download"
                    title="No published builds"
                    description="Publish a client build first. Enrollment bundles are only issued for published builds."
                    action={
                      <a class="ent-button" data-variant="secondary" data-size="small" href={href("/distributions")}>
                        <Icon name="arrow-right" size="small" />
                        <span>Open client builds</span>
                      </a>
                    }
                  />
                }
              >
                <div class="ent-stack">
                  <For each={published()}>
                    {(build) => (
                      <div
                        style={{
                          border: "1px solid var(--ent-border)",
                          "border-radius": "8px",
                          padding: "12px",
                          background: "var(--ent-panel-soft)",
                        }}
                      >
                        <div class="ent-spread" style={{ "margin-bottom": "8px" }}>
                          <div>
                            <div style={{ "font-weight": "600", "font-size": "12.5px" }}>{build.name}</div>
                            <div class="ent-small ent-faint">
                              <span class="ent-mono">{build.slug}</span>
                              <span class="ent-dot-sep" />
                              v{build.version}
                              <Show when={build.publishedAt}>
                                <span class="ent-dot-sep" />
                                published {date(build.publishedAt)}
                              </Show>
                            </div>
                          </div>
                          <Tag tone="success" dot>
                            live
                          </Tag>
                        </div>
                        <div class="ent-stack" style={{ gap: "7px" }}>
                          <div>
                            <div class="ent-label">Manifest</div>
                            <CopyField
                              value={`${origin()}/v1/enterprise/public/client/${build.slug}/manifest`}
                            />
                          </div>
                          <For each={build.deployment.platforms}>
                            {(platform) => (
                              <div>
                                <div class="ent-label">{platform}</div>
                                <CopyField
                                  value={`${origin()}/v1/enterprise/public/client/${build.slug}/download/${platform}`}
                                />
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Card>

          <Card title="Install the server" description="From a checkout, build the binary and start the control plane.">
            <div class="ent-stack">
              <div>
                <div class="ent-label">1 · Build</div>
                <CopyField value="bun run --cwd packages/omnia-enterprise build && bun run --cwd packages/omnia build:server" />
              </div>
              <div>
                <div class="ent-label">2 · Initialize</div>
                <CopyField value={`./packages/omnia/dist/omnia-server init --org "${session.session()!.organization.name}" --admin ${session.session()!.user.email}`} />
              </div>
              <div>
                <div class="ent-label">3 · Start</div>
                <CopyField value="./packages/omnia/dist/omnia-server start" />
              </div>
              <div class="ent-grid ent-grid-2">
                <div>
                  <div class="ent-label">Check</div>
                  <CopyField value="omnia-server doctor" />
                </div>
                <div>
                  <div class="ent-label">Status</div>
                  <CopyField value="omnia-server status" />
                </div>
              </div>
            </div>
            <InlineNote icon="terminal">
              The config lives at <code>~/.omnia-server/config.json</code> (0600) and the state at{" "}
              <code>~/.omnia-server/data/enterprise.json</code>. Override the base directory with{" "}
              <code>--home</code> or <code>OMNIA_SERVER_HOME</code>.
            </InlineNote>
          </Card>

          <Card title="Reverse proxy and TLS" description="Terminate TLS at the proxy and keep the server on loopback.">
            <div class="ent-stack">
              <CodeBlock label="Caddy" code={CADDY} />
              <CodeBlock label="nginx" code={NGINX} />
            </div>
            <InlineNote tone="warning" icon="shield">
              The console session cookie is <code>Secure</code> when the public URL is HTTPS. Run the server with{" "}
              <code>--trust-proxy</code> so audit records and IP allowlists see the real client address rather
              than the proxy.
            </InlineNote>
          </Card>

          <Card title="Systemd" description="A minimal unit for a long-lived deployment.">
            <CodeBlock label="/etc/systemd/system/omnia-enterprise.service" code={SYSTEMD} />
            <CopyField value="sudo systemctl enable --now omnia-enterprise" />
          </Card>

          <Card title="Backups" description="The data directory holds the deployment. Back it up with the config.">
            <div class="ent-stack">
              <CopyField value="tar -czf omnia-backup.tgz -C ~/.omnia-server config.json data" />
              <Definition label="Config">config.json — server token, bind address, public URL</Definition>
              <Definition label="State">data/enterprise.json — people, sessions, policies, audit and usage</Definition>
              <Definition label="Assets">data/assets — uploaded logos, icons and marks</Definition>
            </div>
            <InlineNote tone="warning" icon="warning">
              The state file contains identity records and password hashes. Keep backups on encrypted storage
              with the same 0600 permissions, and restrict who can read them.
            </InlineNote>
          </Card>
        </div>

        <div class="ent-stack org-rail">
          <Card title="Health" description="A live probe of the public endpoint.">
            <Definition label="Status">
              <Tag tone={online() ? "success" : "danger"} dot>
                {online() ? "online" : "unreachable"}
              </Tag>
            </Definition>
            <Definition label="Version">{config()?.version ?? "—"}</Definition>
            <Definition label="Plan">{config()?.plan ?? session.session()!.organization.plan}</Definition>
            <Definition label="Setup complete">
              {config() === undefined ? "—" : config()!.setupRequired ? "no" : "yes"}
            </Definition>
            <Definition label="Checked">{dateTime(Date.now())}</Definition>
            <Button size="small" variant="secondary" onClick={() => window.location.reload()}>
              Re-check
            </Button>
          </Card>

          <Card title="Updates" description="Ship a new console without changing the data files.">
            <div class="ent-stack">
              <CodeBlock label="Console" code={"bun run --cwd packages/omnia-enterprise build"} />
              <CodeBlock label="Server binary" code={"bun run --cwd packages/omnia build:server"} />
            </div>
            <p class="ent-small ent-muted" style={{ margin: 0 }}>
              Restart the process after replacing the binary or the console directory. The store is versioned
              and refuses an unknown format rather than guessing.
            </p>
          </Card>

          <Card title="Client update policy" description="Where each build's update channel is set.">
            <div class="ent-list">
              <a class="ent-list-row" href={href("/distributions")}>
                <span class="ent-auth-point-icon">
                  <Icon name="download" size="small" />
                </span>
                <span class="ent-list-row-main">
                  <span class="ent-list-row-title">Build channels</span>
                  <span class="ent-list-row-sub">stable, beta or pinned version</span>
                </span>
                <Icon name="chevron-right" size="small" />
              </a>
              <a class="ent-list-row" href={href("/settings")}>
                <span class="ent-auth-point-icon">
                  <Icon name="shield" size="small" />
                </span>
                <span class="ent-list-row-main">
                  <span class="ent-list-row-title">License</span>
                  <span class="ent-list-row-sub">Business or Enterprise, verified offline</span>
                </span>
                <Icon name="chevron-right" size="small" />
              </a>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
