# Omnia feature roadmap: Dots comparison and sandbox services

**Research date:** 2026-10-09

**Baseline:** Omnia `main`, security/MCP commit `b65d330238`

**Status:** planning record; no sandbox implementation or deployment is claimed.

The user requested Dots research and cross-platform sandboxing. After discussing
Firecracker's Linux/KVM requirement, implementation was deferred: **put it on
the plan**. The proposed first backend is Docker/Podman; this is a recommendation,
not a claim that the user has approved or provisioned that engine.

## Research conclusion

OpenAI announced Dots on September 29, 2026. Its distinguishing proposition is
an ongoing personal agent that owns responsibilities, coordinates background
work, and follows up between conversations, with a persistent cloud computer
and multiple contact channels.

Omnia already implements many agent primitives: computer/browser control,
code tools, multiple providers, persistent memory, superskills, subagents,
discussion specialists, remote computers, scoped approvals, interval schedules,
and headless runs. The largest gaps are the orchestration and service layers
that turn those primitives into an always-available assistant.

The comparison is based on official public documentation and source inspection,
not hands-on access to Dots. Official docs currently differ on mobile creation
and texting rollout. Specialist dots are enterprise pilots, and teams of
personal dots are described as future work; do not treat either as generally
available functionality Omnia must immediately match.

## Feature comparison

| Dots capability | Omnia today | Missing work |
| --- | --- | --- |
| Persistent responsibility across conversations | Sessions, scoped memory, projects and reusable agents exist. | A durable assistant identity, responsibility/goal records, progress and decision state, and a coordinator that continues work between messages. |
| Self-directed wakeups and event monitoring | `agent-run/scheduler.ts` polls interval schedules; each run creates a new session. | Durable wakeup queue, event subscriptions, deduplication, task continuation, retry/recovery, and adaptive next-wakeup decisions. |
| Own always-available cloud computer | Hosted control plane/headless execution and paired computers exist. | Provisioned isolated compute per user/task, guest images, persistent workspace/browser state, lifecycle management, and interactive inspection. Hosted text execution alone is not a dedicated cloud desktop. |
| Proactive research | Search, memory and research-capable subagents exist. | A distinct background lane restricted in code to permitted read-only sources, with findings routed back as suggestions. It must not inherit shell/browser/desktop mutation tools. |
| Several tasks while the user keeps talking | Task/subagent tools and Discussion Room exist; asynchronous subagents are feature-flagged. | Durable responsibility-to-task coordination, prioritized scheduling, follow-up steering, and a consolidated activity/decision view. Multi-agent execution itself is not missing. |
| Activity, scheduled and completed work in one place | Session timelines, tool cards, task cards, notifications and Settings runs list exist. | A cross-session activity hub showing running, waiting-for-user, scheduled, failed and completed tasks, with outputs and source-environment links. |
| Rich recurring schedules | `ScheduledRun` stores `intervalMinutes` and `enabled`; limits are 20 runs, minimum 15 minutes. | Timezone-aware named times, weekday schedules, one-shot reminders, end dates, notification conditions and delivery destinations. |
| App ecosystem | MCP Marketplace, OAuth support in the engine, and superskills exist. | Productized connected-app accounts, per-action read/write permissions, reconnection UX, events and background subscriptions. Catalog count is not connected-app parity. |
| Same assistant in Slack/Teams/mobile | Desktop/web UI and a separate Slack package exist. | Unified identity and context across channels, owner authorization, audience-specific disclosure, Teams/mobile access and notification routing. `packages/slack/src/index.ts` currently maps Slack threads to separate sessions with an in-memory map. |
| Live voice conversations | A speech-recognition adapter helper exists. | A wired realtime voice interface with conversation continuity, interruption, task delegation and progress updates. The helper is not a working voice agent. |
| Memory and personalization | `MemoryRecord` supports scope, confidence, sensitivity, tags and expiry; individual memory controls exist. | Ongoing responsibility notes, feedback-to-preference updates and cross-channel retrieval with audience boundaries. Do not describe persistent memory as absent. |
| Private sign-in and human takeover | Vault-based credential injection, browser panel, pairing, input release and approval mechanisms exist. | A private sign-in request flow, encrypted credential service, and explicit guest/browser control ownership with take-over/return-control semantics. Local browser interaction is not remote VM desktop takeover. |
| Custom rules and action review | Scope/permission rules, fingerprint-bound approvals, verification and security journals exist. | Task-specific rules for recipients, payloads and disclosure; a separate reviewer before consequential app actions; rules carried into delegated/background work. Logging is not active action review. |
| Enterprise agent identities and governance | GitHub identity, plan markers, paired machines and specialist rosters exist. | Durable resource ownership, role enforcement, service identities, SSO/MFA integration, administrative policies and audit export. Discussion specialists are not independently provisioned enterprise identities. |

### Source evidence for Omnia

- Scheduling and headless execution: `packages/omnia/src/agent-run/{store,scheduler,runner,client}.ts`.
- Runs UI and IPC: `packages/app/src/components/settings-runs.tsx`, `packages/desktop/src/main/omnia/runs.ts`.
- Agent delegation: `packages/opencode/src/tool/task.ts`, `packages/opencode/src/tool/discussion.ts`.
- Memory: `packages/omnia/src/memory/types.ts`, `packages/app/src/components/settings-memory.tsx`.
- Notifications: `packages/app/src/context/notification.tsx` currently models turn-complete/error notifications.
- Connected tools: `packages/app/src/components/settings-mcp-marketplace.tsx`, `packages/opencode/src/mcp/index.ts`.
- Current remote control architecture: `packages/desktop/src/main/omnia/{server-call,server-host,remote-agent}.ts`.
- Open security gaps: `docs/security-audit.md`.

## Cross-platform sandbox services plan

### Architecture

Build Omnia's own lifecycle/API/UI layer around maintained isolation engines.
Do not implement a new hypervisor or advertise process restrictions as microVM
isolation. Model the execution host separately from the desktop client: a Mac
or Windows client can manage a sandbox running on a Linux service.

Proposed backend progression:

1. **Docker/Podman:** cross-platform service contract and first usable execution
   backend. Requires an installed/configured engine; do not silently install or
   assume one exists. Prefer rootless execution where supported.
2. **Firecracker:** optional Linux-only microVM backend on hosts with KVM,
   supported architecture, verified guest images and jailer/supervisor setup.
3. **Native VM backends:** evaluate macOS Virtualization.framework and Windows
   Hyper-V/WSL2 when stronger local isolation is needed. These require separate
   platform implementations and prerequisites.
4. **Managed providers:** E2B/Daytona or another provider may be added later,
   only after a provider choice, credential flow and data-placement contract.

Docker/Podman on Linux uses containers sharing the host kernel; it is not
equivalent to Firecracker. macOS/Windows engines usually run Linux containers
inside a VM, but that VM may be shared by multiple containers. Show the actual
backend and isolation class in the UI; do not label every sandbox a microVM.

### Milestone 0 — ownership and execution boundary

- Decide whether the first service is hosted, desktop-local, or both.
- Resolve a sandbox owner from authenticated credentials, never request-body
  profile claims. Enforce ownership on every operation, listing and event.
- Preserve owner/template reservations across service restarts; define a
  fail-closed migration for existing unassigned resources.
- Separate host orchestration/credentials from guest execution. Guests must not
  be able to modify the control plane or required review/permission checks.
- Define availability, quotas, backend prerequisites and truthful unavailable
  states before adding UI switches.

### Milestone 1 — lifecycle service

- Shared provider contract: `capabilities`, `create`, `start`, `stop`, `status`,
  `list`, `exec` and `destroy`.
- Maintain runtime state separately from durable desired state; a starting
  process is not proof of guest readiness.
- Enforce per-owner/global CPU, memory, disk, process and concurrency limits.
- Give each sandbox a private workspace, opaque ID, TTL and explicit retention
  policy. Stop, destroy and workspace deletion are distinct operations.
- Time-bound startup/requests; supervise backend exit; recover or quarantine
  stale state; clean up after partial creation and service failure.
- Never fall back to host execution when guest/backend execution fails.

### Milestone 2 — first backend and agent execution

- Use verified, pinned template images. Track template digest, architecture,
  version and guest-agent capabilities; no arbitrary image URL in a task call.
- Default to no host bind mounts, container-engine socket, host PID/network
  namespace, privileged mode or device passthrough.
- Disable network by default. Explicitly granted network access requires an
  egress policy; a generic bridge alone is not an allowlist or metadata guard.
- Apply dropped capabilities, no-new-privileges and the engine's seccomp policy;
  expose which restrictions were actually applied.
- Define writable private workspace/tmp paths and a read-only base filesystem
  where compatible with the template.
- Run commands only inside the selected sandbox with bounded output, timeout,
  cancellation and complete process-tree cleanup.
- Add explicit artifact import/export. Validate paths, symlink ancestors,
  sizes and permissions; raw host file APIs must not bypass the guest boundary.
- Add an agent-facing sandbox tool and policy-controlled routing. Host shell and
  sandbox execution must remain visibly distinct in the transcript.

### Milestone 3 — desktop management and inspection

- Expose the same authenticated platform/preload service in all desktop builds.
- Show backend/isolation class, owner, readiness, resources, active jobs and
  expiry. Provide create/start/stop/execute/destroy actions with clear results.
- Add guest terminal and artifact inspection.
- Add browser/desktop inspection later with explicit take-over/return-control
  ownership; lifecycle CRUD alone does not fulfill the Dots cloud-computer UX.
- Use localized labels and typed API results, including missing-engine and
  offline-host states. Never show a successful sandbox switch when execution
  still runs on the host.

### Milestone 4 — validation and platform builds

Required regressions:

- A guest cannot read a host-only sentinel or modify host control-plane files.
- No engine socket, host mount or privilege escalation is introduced by task
  parameters.
- Network defaults/egress rules, resource exhaustion limits and cancellation
  behave as configured.
- Account B cannot list, execute in, export from, stop or destroy account A's
  sandbox, including after reconnect/restart.
- Partial creation, backend failure, timeout and service restart do not leave
  uncontrolled execution or silently route to a host shell.
- Linux/macOS/Windows clients report unavailable prerequisites accurately.

Then produce matching artifacts from the same verified source:

- Linux AppImage.
- Windows NSIS setup EXE, with target-platform/architecture overrides applied
  during **both compilation and packaging**. A Windows ZIP is not a setup EXE.
- macOS DMG on a reachable Mac. Verify bundle identity and selected architecture.
- Verify artifact contents/checksums and record signing/notarization status.
  Packaging success alone is not an execution or isolation test.

Current build follow-ups: Wine/NSIS prerequisites blocked the last Linux
cross-build of the Windows setup; the Tailscale Mac was offline. The latest
portable Windows ZIP must be validated for target-specific native modules
before calling it usable, since its preceding compilation used Linux defaults.

## Recommended feature order

1. Ownership foundations and sandbox execution service.
2. Durable responsibility/task coordinator with checkpointing and recovery.
3. Explicit read-only proactive research and event-triggered work.
4. Unified Activity/decisions/outputs hub and richer schedules.
5. Productized connected apps and channel adapters.
6. Private sign-in/takeover and contextual action review.
7. Live voice/mobile experience and enterprise service identities.

Memory, remote control, code tools and Discussion Room should be extended rather
than rebuilt. Avatar customization is lower priority than these execution and
workflow gaps.

## Official sources

1. [OpenAI — Introducing dots](https://openai.com/index/introducing-dots/), September 29, 2026.
2. [ChatGPT Learn — Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory).
3. [ChatGPT Learn — Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps).
4. [ChatGPT Learn — Message your dot](https://learn.chatgpt.com/docs/dots/channels).
5. [ChatGPT Learn — Control your dot](https://learn.chatgpt.com/docs/dots/controls).
6. [OpenAI Help Center — Getting started](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot).
7. [OpenAI — Dots safety, security and privacy](https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/).
8. [OpenAI Help Center — Enterprise workspace controls](https://help.openai.com/en/articles/20001554-manage-dots-in-chatgpt-workspaces).
9. [Firecracker — Getting started and Linux/KVM prerequisites](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md).

Docs and rollout details can change; re-check these sources before implementation
or making product-parity claims.
