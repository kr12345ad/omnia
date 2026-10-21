# Omnia — Full Feature Context

Omnia is a desktop AI computer environment: an Electron app (forked from OpenCode Desktop) that gives an LLM agent full control of the user's real computer, with real GUI automation, persistent memory, teachable skills, and multi-agent discussion. UI seasonal version v26.10 (client `26.10.0`); the self-hosted control plane ships as `1.0.3`. Lean AppImage (210MB) installed at ~/Applications/Omnia.AppImage with a start-menu entry; no auto-updates, no phone-home, no publishing.

## Architecture
- packages/desktop: Electron main process. Hosts the Omnia Server, the embedded OpenCode engine, IPC, overlay window (halo), updater (disabled), packaging (electron-builder, lean AppImage: no models, no CUDA/ROCm; CPU+Vulkan llama.cpp bundled).
- packages/app: SolidJS renderer. New v2 interface (Inter typography), tabs, drafts, session timeline, settings.
- packages/ui + packages/session-ui: shared components, tool cards, timeline rendering.
- packages/omnia: Omnia Server — local HTTP + SSE API (v1), token-auth, server.json discovery. Owns computer control, permissions, credentials, memory, superskills, computer-use models, pairing, events.
- packages/opencode: OpenCode engine fork — sessions, agents, tools, providers, skills, subagents.

## Modes and sessions
- Two modes: Agent (internal id "work") and Code. Drafts can switch modes until the first message. Tool surfaces are mode-scoped (e.g., computer tools and Discussion Room only in Agent mode).
- Tabs with drafts, session tabs, new-tab inherits mode; mode toggle with sliding pill animation; command palette; keybinds.
- Session timeline: streaming markdown with fade-in, thinking blocks, tool cards, task/subagent cards, permission prompts, retry states, progress indicators.

## Session import
- Onboarding and Settings → General → Advanced → Sessions import history from an existing OpenCode install (`opencode*.db` under the XDG data dir) and from Codex CLI rollouts (`~/.codex/sessions/**/rollout-*.jsonl`, 50 MB per file). Sources are read-only; everything lands in `<userData>/OMNIA.db`.
- Sessions keep their ids and bring their project, project-directory, message, part, `session_message` (durable V2 history), todo and share rows; pending `session_input` prompts, credentials and settings are never copied. Codex files become Code-mode sessions whose rows satisfy the V1 message/part schemas.
- Imports are `INSERT OR IGNORE` and committed in 50-session chunks, so they are re-runnable and resumable, and a 2 GB source imports in ~11 s at ~350 MB RSS. A ledger at `<userData>/session-import.json` records each run. Details: `docs/session-import.md`.

## Computer control (the core differentiator)
- Platform drivers: Linux (AT-SPI accessibility tree + X11 and Wayland input), macOS (System Events/AX, CoreGraphics, screencapture), Windows (UIA via PowerShell, user32).
- Action surface: observe, find, click, double-click, right-click, type, scroll, drag, resize, key, screenshot, read_value, run_command (shell with sudo stdin, env vars, output redaction), wait, browser control, focus_window with KWin verification, minimize fallback (Super+Down).
- Input freeze: X11 pointer/keyboard grab; double-Escape releases; SSE events input.frozen/input.released.
- Halo overlay: multi-layer blue glow around the screen border while native computer-use runs; click-through; only during native computer-use, not thinking.
- Permissions: scoped (UI_READ, UI_CONTROL, KEYBOARD, POINTER, CLIPBOARD_READ/WRITE, SCREEN_READ, PROCESS_EXECUTE, SECRETS); per-action approval; every action gated server-side before dispatch.
- Credentials vault: 0600 JSON store; per-computer ownership; rules by command/application/url; env injection; secret redaction in outputs; sudo password via stdin.
- Pairing and remote computers: pairing codes (single-use, expiring), remote driver queue/long-poll protocol, RemoteAgent CLI (`omnia`), desktop UI (Add computer, Pair with a code, status banner, unpair). One host runs the server; other computers can be controlled remotely.
- Browser automation: bundled browser runtime; find/save/copy images; DOM + screenshot hybrid.

## Computer-use models (vision/grounding)
- Local inference via llama.cpp: CPU and Vulkan runtimes bundled; CUDA 12.8 and ROCm downloadable in Settings.
- Catalog: UI-TARS 2B Q4_K_M (default grounding, normalized-1000 coordinates), Moondream 2 Q4_K (semantic question answering), ShowUI entries. Moondream 3 Preview cannot ship locally (no GGUF).
- Settings > Computer > Computer use: per-model download/load/unload/remove, runtime install/remove, downloads toggle, runtime status, hardware report.
- Shared storage: models in ~/.omnia/models (plus bundled search dir), runtimes in ~/.omnia/runtimes, so dev and packaged apps see the same installs.
- computer_visual tool: operation (ground/click/type/scroll/question/inspect) plus question/text; analyze API returns structured decisions, fallbacks, error codes.

## Agent capabilities
- Tools: shell/run_command, file read/write/edit/glob/grep, browser, all computer_* actions, memory, superskills, task (subagents), discussion_room, todos.
- Memory: persistent memories with scope/tags/confidence, search, delete, stats; Settings > Memory. Injected contextually into prompts.
- Superskills: teach the agent an application's UI once — a JSON-RPC bridge plus named methods — then reuse; create-with-AI flow writes the instructions and methods; enable/disable; Settings > Superskills.
- Discussion Room: manager agent orchestrates four specialists (strategist, builder, researcher, critic) over N rounds on a topic with a goal; each specialist breaks off into real subagent work; manager synthesizes decision + assignments + reports; Agent mode only; new-discussion dialog and quick action on the Agent home; timeline card with live participant chips.
- Subagents/task tool with depth rules; todo lists.

## Settings and shell
- Settings tabs: General (appearance, UI/code/terminal fonts, sounds, permission scopes), Shortcuts, Servers, Providers, Models, Superskills, Memory, Computer use, Computers.
- Providers: multi-provider (opencode/Anthropic/OpenAI/Google/etc.), OAuth (GitHub, provider device flows), free-tier compatible versioning, model picker.
- Projects/workspaces: project list, worktrees, session history per project; home screen with quick actions (discussion, research, files, spreadsheet, application, browser, agent, superskill), recent sessions, superskill summary.
- Files/terminal: file tree, editor preview, integrated terminal, review pane with line comments, git diff views.
- i18n: typed language layer with parity tests; desktop native menus localized.

## Distribution and runtime
- Lean AppImage: electron-builder, AppImage only, no publish, updater compiled out; bundles icons, CPU+Vulkan llama.cpp; optional full builds via OMNIA_INCLUDE_MODELS=1 / OMNIA_INCLUDE_ALL_LLAMA=1.
- start-menu entry ~/.local/share/applications/omnia.desktop, icon hicolor/omnia.png.
- Dev workflow: packages/desktop bun run build; run from packages/desktop with electron; server.json in ~/.config/io.omnia.desktop(.dev).

## Enterprise control plane
- `omnia-server` (`packages/omnia/src/server/cli.ts`) is the self-hosted control plane: one config, one JSON store, the admin console at `/admin`, and a per-tenant API at `/v1/enterprise`.
- Deployments are `lan` or `public`. LAN mode answers manifests and downloads at whatever address the client reached and binds `0.0.0.0` by default; public mode pins `publicUrl` and refuses to publish a build while client telemetry is off, so off-network installs stay traceable.
- Client builds are real electron-builder packages, not just enrollment JSON. `packages/omnia/src/enterprise/releases.ts` prepares the desktop toolchain, packages every selected platform the host supports (macOS requires a macOS host, Windows cross-builds need wine), records each attempt with a bounded log, and serves the artifact with its SHA-256. Platforms the host cannot build report why and fall back to the enrollment file.
- Builds are filed under `<home>/data/releases`, the same directory the manifest points at. A download URL for a published build starts the build when the artifact is missing and answers 202 with a self-refreshing page until the package is ready, so the link operators paste into MDM always ends in an installer.
- An installer built where this host cannot package (a Mac, a Windows runner) is registered with `omnia-server builds import <slug> --platform <p> --file <artifact>`; it lands in the same directory with its SHA-256, so `builds installer` and the published manifest serve it like a locally built one.
- `GET /v1/enterprise/public/client/<slug>/update` is the update feed: the published version, channel, pinned/minimum versions, auto-update and downgrade rules, and each platform's artifact URL and checksum. `omnia-server builds feed <slug>` prints it.
- Usage is reported by the client, not inferred: the desktop batches finished turns into `userData/enterprise-usage.json` and posts them to `/v1/enterprise/public/client/<slug>/usage` with the client token, deduplicated by assistant message id and retried while offline. A build whose telemetry is turned off deletes its queue instead of sending it, which is what makes the console's usage, seat and limit figures real.
- SCIM 2.0 covers users and groups end to end: Users GET/POST/PATCH/DELETE with `userName`/`externalId` filters, Groups GET/POST/PUT/PATCH/DELETE with `displayName` filters and membership add/remove/replace, so an IdP's teams drive model access and per-team limits. A `userName` change is refused rather than half-applied; the address is the account's identity.
- Organization retention is enforced, not just published: `data.retentionDays` prunes usage events and `audit.retentionDays` prunes the audit trail when the server starts.

## Known constraints
- CUDA/ROCm prebuilt runtimes cannot execute on the current Rocky 9 host (glibc) but are downloadable for other systems; Vulkan works via bundled libstdc++.
- X11 input-freeze integration tests are environment-sensitive (fail while the session is locked).
- i18n parity test fails by design (English-only source copy).
- Moondream community GGUF has degraded grounding accuracy; UI-TARS is the reliable grounding model.
