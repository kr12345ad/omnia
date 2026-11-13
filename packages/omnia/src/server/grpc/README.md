# Omnia gRPC and gNMI

This directory adds two structured interfaces to the existing Omnia server:

- **gRPC** for typed Omnia operations that are not YANG data (computer
  inventory, lifecycle and a health check).
- **gNMI** for standard OpenConfig state retrieval and subscriptions, modeled
  by [`models/omnia.yang`](./models/omnia.yang).

The HTTP API remains the primary control surface. Starting gRPC does not replace,
proxy or change any HTTP route. Computer execution, approvals, screenshots and
session actions stay on the existing HTTP routes so their permission, approval,
verification and audit boundaries remain authoritative.

## Architecture

```text
HTTP API (existing) ──┐
                      ├── ComputerManager / PermissionManager / GitHubAuth
gRPC transport ───────┤
  gNMI service ───────┤──> models/omnia.yang paths ──> live server state
  ComputerService ────┘
  HealthService

EventBus (existing) ─────> subscription dirty paths ─────> STREAM / SAMPLE updates
```

- `server.ts` starts the gRPC listener as part of `startOmniaServer()`. gRPC is
  enabled by default on `127.0.0.1` with an ephemeral port; `grpc.enabled: false`
  is the explicit opt-out. The bound URL is exposed as `server.grpc.url`, and
  shutdown releases all subscriptions before the HTTP listener closes.
- `auth.ts` reuses Omnia's root bearer token and `GitHubAuth` client tokens. It
  does not invent a second account system.
- `state.ts` reads the same `ComputerManager`, sessions, chat runtime and
  permission snapshot the HTTP server uses. It does not cache or duplicate a
  second source of truth.
- `subscriptions.ts` consumes the existing `EventBus`; it does not create a
  second internal event system. Paths are re-resolved from live state when an
  event arrives, so an event is a wake-up signal rather than a copied payload.
- `services/computer.ts` calls `ComputerManager.connect()` and
  `ComputerManager.disconnect()` and records those operations in the security
  journal. It does not contain computer execution logic.
- `services/gnmi.ts` implements the official gNMI RPCs, path authorization and
  the single writable configuration leaf.

A `grpc` subsystem is added to `/v1/health` once the listener is bound. If the
gRPC listener cannot bind, `startOmniaServer()` closes the HTTP listener,
releases resources and rejects instead of reporting a healthy server.

## Protocol sources and generation

The gNMI protocol is the real OpenConfig service, not a lookalike:

- [`proto/gnmi.proto`](./proto/gnmi.proto) is the official
  `github.com/openconfig/gnmi/proto/gnmi/gnmi.proto` definition, including the
  `gnmi_service = "0.10.0"` file option and the official request/response
  messages.
- [`proto/gnmi_ext/gnmi_ext.proto`](./proto/gnmi_ext/gnmi_ext.proto) is the
  official extension definition imported by `gnmi.proto`.
- [`proto/omnia.proto`](./proto/omnia.proto) defines the small
  `omnia.v1.ComputerService` and `omnia.v1.HealthService` APIs.

The server does not read `.proto` files at runtime. `generated/descriptor.ts`
contains a base64-encoded `FileDescriptorSet`, which keeps
`bun build --compile` working without a runtime asset path. Regenerate it after
changing any `.proto` file:

```bash
cd packages/omnia
bun run generate:grpc
```

`script/generate-grpc-descriptor.ts` loads the vendored files with `protobufjs`
and rewrites `src/server/grpc/generated/descriptor.ts`. Do not edit that file by
hand. Keep the vendored `.proto` files as the reviewable source of truth.

## YANG model

[`models/omnia.yang`](./models/omnia.yang) defines the `omnia` module, namespace
`https://github.com/kr12345ad/omnia/yang/omnia`, with the root container
`omnia`. The paths below are implemented. List shorthands such as
`/omnia/computers/{id}/status` are accepted and normalized to the YANG list form
`/omnia/computers/computer[id={id}]/status`; the canonical keyed form is also
accepted.

| Path | Kind | Contents |
| --- | --- | --- |
| `/omnia` | container | Whole modeled tree (permission-filtered) |
| `/omnia/server` | container | `status`, `health`, optional `execution` |
| `/omnia/server/status` | container | Server state, version, protocol, API prefix, ID, timestamps, URL |
| `/omnia/server/health` | container | Aggregated health and the `subsystem` list |
| `/omnia/server/execution` | container | Most recent semantic execution (`last`) |
| `/omnia/server/execution/last` | container | Action, success, verification, provider/model and timestamp |
| `/omnia/computers` | container | `computer` list visible to the caller |
| `/omnia/computers/{id}` | list entry | Identity, status, capabilities and sessions |
| `/omnia/computers/{id}/status` | container | Connectivity, platform, backend, driver and last-seen |
| `/omnia/computers/{id}/capabilities` | container | `capability` list with permissions and limitations |
| `/omnia/computers/{id}/sessions` | container | `session` list scoped to that computer |
| `/omnia/sessions` | container | `session` list visible to the caller |
| `/omnia/sessions/{id}` | list entry | One session's computer, action count and last action time |
| `/omnia/chat/channels` | container | `channel` list |
| `/omnia/chat/channels/{platform}` | list entry | Channel state, credential names present, activity and owner |
| `/omnia/config/permissions` | container | `scope` list of permission scopes |
| `/omnia/config/permissions/{scope}` | list entry | Scope name and state |
| `/omnia/config/permissions/{scope}/state` | leaf | **The only writable leaf** (`granted`, `denied`, `prompt`) |

List keys are `computer[id]`, `session[id]`, `channel[platform]` and
`scope[name]`. Unknown elements, unknown keys and unsupported origins are
rejected with `INVALID_ARGUMENT`.

Anything not listed above is state (`config false`) and read-only. In
particular, computer execution, screenshots, credentials, browser control and
chat message content are intentionally not exposed as YANG data or writable
configuration.

`Get` supports the standard data types `ALL`, `CONFIG`, `STATE` and
`OPERATIONAL`. `CONFIG` returns only the permission subtree; `STATE` and
`OPERATIONAL` omit it. A `Get` with no paths returns the prefix itself, or the
`/omnia` root when no prefix is supplied.

### Writable configuration

`Set` accepts `update` and `replace` for
`/omnia/config/permissions/scope[name={scope}]/state`, and returns a standard
`SetResponse` with one `UpdateResult` per operation. Values are validated
against `PERMISSION_STATES` before any change is applied, so a bad request
cannot partially update the policy. Only the deployment operator may write;
client tokens receive `PERMISSION_DENIED`. Each applied change emits the
existing `permission.changed` EventBus event and is recorded in the security
journal.

`delete` and `union_replace` are not implemented: deleting a permission scope
has no defined default in Omnia, and silently accepting either would misstate
the supported surface. They return `UNIMPLEMENTED` rather than a fabricated
success.

## Encodings and capabilities

`Capabilities` advertises exactly what is implemented:

- gNMI version `0.10.0`
- encoding `JSON_IETF` only
- model `omnia`, organization `Omnia`, version `0.1.0`

`JSON`, `PROTO`, `ASCII` and any other encoding are not advertised. `Get` and
``Subscribe` reject unsupported encodings with `INVALID_ARGUMENT`. Responses use
`TypedValue.json_ietf_val` containing UTF-8 JSON. RFC7951 string forms are used
for `uint64` and `decimal64` leaves.

Model names in `SubscribeRequest.subscribe.use_models` must be omitted or
`omnia`. Aggregation is not modeled and is rejected with `UNIMPLEMENTED`.

## Subscriptions

Subscriptions use the official bidirectional `Subscribe` stream:

| Mode | Behavior |
| --- | --- |
| `ONCE` | Sends one initial snapshot, a `sync_response`, then ends the stream |
| `POLL` | Sends an initial snapshot and `sync_response`; each `poll` request produces a fresh snapshot and `sync_response` |
| `STREAM` | Sends an initial snapshot, `sync_response`, then updates until cancellation |

For `STREAM`, the per-path subscription modes are:

- `TARGET_DEFINED` — treated as `ON_CHANGE` because Omnia's model has no
  sampling semantics that a target should choose on the client's behalf.
- `ON_CHANGE` — driven by matching EventBus events. State is re-resolved from the
  live source, and dirty paths are coalesced.
- `SAMPLE` — resolves the path on a fixed interval. Intervals must be between
  100 ms and 1 hour.

`suppress_redundant` is honored by comparing the serialized value with the last
value sent. `heartbeat_interval` is valid for `SAMPLE` and `ON_CHANGE`
subscriptions, restricted to 100 ms–1 hour; a heartbeat is an unconditional
update and therefore bypasses `suppress_redundant`.

`updates_only` omits the initial values but still sends `sync_response` before
ongoing updates.

For `STREAM`, snapshot/subscription ordering is race-free: the session
subscribes to the EventBus before it starts resolving the snapshot, buffers
events that arrive during snapshot construction, then replays their affected
paths. Updates that land during the snapshot cannot be lost. `POLL` and `ONCE`
do not hold a live EventBus listener; `POLL` re-authorizes on every poll.

Every snapshot and every update is re-authorized, including after a slow state
read completes. `auth.signed_out` wakes every stream so a revoked client token
cannot keep an idle subscription open. Broad list subscriptions
(`/omnia/computers`, `/omnia/sessions`) are filtered per caller; a caller cannot
receive another account's computer or session through a list, and a concrete
path outside its visibility fails closed. Cancellation, client disconnect,
stream errors, validation failures and server shutdown all release the event
listener and timers. Subscription state is process-local: there is no durable
resume or replay after reconnecting.

Backpressure follows gRPC's `write()` contract. When the transport signals
saturation, update emission pauses until `drain`; dirty paths remain coalesced in
a bounded set rather than growing an unbounded frame queue. A subscription list
over 512 paths, a backlog over 512 pending paths, or more than 1024 events
buffered while the initial snapshot resolves fails with `RESOURCE_EXHAUSTED`
instead of consuming unbounded memory.

## Custom gRPC services

`omnia.v1.ComputerService`:

- `ListComputers` — visible computers from `GnmiStateSource`
- `GetComputer` — one visible computer, `NOT_FOUND` if unknown
- `ConnectComputer` — operator-only; calls `ComputerManager.connect()`
- `DisconnectComputer` — operator-only; calls `ComputerManager.disconnect()`

`omnia.v1.HealthService.Check` reports `SERVING` while ready or degraded and
`NOT_SERVING` while starting, failed, stopping or stopped, plus version,
protocol, uptime and counts.
Connect/disconnect use the existing manager, are denied to non-operator tokens,
and write `grpc.computer.connect` / `grpc.computer.disconnect` records to the
security journal. No action/execute RPC is exposed: computer execution stays on
the audited HTTP path.

Server reflection is not enabled. Use the vendored `.proto` files with
`grpcurl` or generated bindings.

## Authentication and security

- Every RPC, including `Capabilities` and the streaming `Subscribe`, requires
  gRPC metadata `authorization: Bearer <token>`. Missing or invalid credentials
  return `UNAUTHENTICATED`; the server audits authentication failures.
- The deployment operator token is the same root token returned by
  `startOmniaServer()`. It has full read access and is the only principal that
  may `Set` configuration or connect/disconnect computers.
- Desktop client tokens may read server, computer, session and chat state within
  their visibility. Agent client tokens may read server state and only the
  computers/sessions they own or that are unowned and have no remote credential;
  they cannot read chat channels or configuration and cannot perform operator
  operations.
- The gRPC listener binds to loopback by default. Off-loopback binding requires
  explicit `grpc.allowRemote: true` **and** TLS; cleartext remote binding is
  refused. TLS uses `grpc.tls.cert` and `grpc.tls.key` as PEM **contents** (not
  file paths); supplying `grpc.tls.rootCert` and
  `grpc.tls.clientCertRequired: true` additionally requires and verifies a
  client certificate.
- Authorization is per path, not per service. `Set` requires operator access to
  the permission leaf; `Get` and `Subscribe` enforce the same `authorizePath`
  rules on snapshots and live updates.
- Chat channel values are never exposed: the model reports credential names and
  connection state, not tokens. Computer capability metadata is the same
  non-secret metadata the existing HTTP summary exposes.

## Client examples with `gnmic`

The examples below use the independent OpenConfig gNMIc client, not Omnia's own
client code. Export the target and operator token first:

```bash
export TARGET=127.0.0.1:43170       # server.grpc.port
export TOKEN='...'                   # server.token
```

Capabilities:

```bash
gnmic -a "$TARGET" --insecure \
  -H "authorization=Bearer $TOKEN" \
  capabilities
```

Get modeled state (JSON_IETF is Omnia's only encoding):

```bash
gnmic -a "$TARGET" --insecure \
  -H "authorization=Bearer $TOKEN" \
  -e json_ietf \
  get --path /omnia/server/status --path /omnia/computers

gnmic -a "$TARGET" --insecure \
  -H "authorization=Bearer $TOKEN" \
  -e json_ietf \
  get --path /omnia/computers/my-computer/capabilities
```

Set the only writable leaf:

```bash
gnmic -a "$TARGET" --insecure \
  -H "authorization=Bearer $TOKEN" \
  -e json_ietf \
  set \
  --update-path '/omnia/config/permissions/scope[name=SECRETS]/state' \
  --update-value granted
```

Subscribe `ONCE`:

```bash
gnmic -a "$TARGET" --insecure \
  -H "authorization=Bearer $TOKEN" \
  -e json_ietf \
  subscribe --path /omnia/server/status --mode once
```

Subscribe `STREAM` with `ON_CHANGE`:

```bash
gnmic -a "$TARGET" --insecure \
  -H "authorization=Bearer $TOKEN" \
  -e json_ietf \
  subscribe \
  --path /omnia/server/status \
  --mode stream --stream-mode on-change
```

Subscribe `POLL` and poll on demand:

```bash
gnmic -a "$TARGET" --insecure \
  -H "authorization=Bearer $TOKEN" \
  -e json_ietf \
  subscribe \
  --path /omnia/computers \
  --mode poll
```

In poll mode gNMIc asks for the target and subscription on stdin; each Enter sends
a poll request. The server answers each one with a fresh snapshot followed by
`sync-response`.

Subscribe with `SAMPLE` and a heartbeat:

```bash
gnmic -a "$TARGET" --insecure \
  -H "authorization=Bearer $TOKEN" \
  -e json_ietf \
  subscribe \
  --path /omnia/server/health \
  --mode stream --stream-mode sample \
  --sample-interval 5s --heartbeat-interval 30s
```

TLS (server certificate, optional client certificate):

```bash
gnmic -a omnia.example.internal:43170 \
  --tls-ca ca.pem \
  --tls-cert client.pem --tls-key client-key.pem \
  -H "authorization=Bearer $TOKEN" \
  capabilities
```

For a local development certificate, gNMIc's `--skip-verify` can be used
instead of `--tls-ca`; do not use it against a production listener.

`gnmic` prints the standard gNMI response, including `"sync-response": true`
for `ONCE`, `POLL` and the initial `STREAM` synchronization.

### Custom services with grpcurl

Because reflection is not enabled, point `grpcurl` at the vendored proto tree:

```bash
grpcurl -plaintext \
  -import-path packages/omnia/src/server/grpc/proto \
  -proto omnia.proto \
  -H "authorization=Bearer $TOKEN" \
  -d '{}' "$TARGET" omnia.v1.ComputerService/ListComputers
```

## Limitations and future work

- Only the permission scope state is writable. There is no writable server,
  computer, session or chat configuration.
- `delete` and `union_replace` return `UNIMPLEMENTED`; there is no `Replace`
  semantics beyond treating a replace of the permission leaf as an update.
- No `JSON`, `PROTO`, `ASCII`, aggregation, batching or non-`omnia` model
  support.
- `/omnia/server/execution/last` is the most recent
  `computer_use.executed` event retained by the existing bounded EventBus
  history (512 events). It is not durable execution history and is lost on
  restart. Use the security journal or HTTP run endpoints for a durable trail.
- The model is a snapshot of current state. There is no historical query,
  subscription replay, durable resume, or last-value cache across reconnects.
- Omnia is a single target: a `target` value is ignored, while conflicting
  prefix/path targets are rejected. `origin` must be omitted or `omnia`.
- There is no per-call gRPC rate limiter; bearer authentication and per-path
  authorization are enforced on every call, and failed authentication is
  audited.
- TLS certificates are read when the server starts; rotation requires a server
  restart.
- Server reflection and gRPC-Web are not provided.
