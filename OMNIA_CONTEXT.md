# Omnia — Full Feature Context

Omnia is a desktop AI computer environment: an Electron app (forked from OpenCode Desktop) that gives an LLM agent full control of the user's real computer, with real GUI automation, persistent memory, teachable skills, and multi-agent discussion. UI seasonal version v26.10-devel-5. Lean AppImage (210MB) installed at ~/Applications/Omnia.AppImage with a start-menu entry; no auto-updates, no phone-home, no publishing.

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

## Known constraints
- CUDA/ROCm prebuilt runtimes cannot execute on the current Rocky 9 host (glibc) but are downloadable for other systems; Vulkan works via bundled libstdc++.
- X11 input-freeze integration tests are environment-sensitive (fail while the session is locked).
- i18n parity test fails by design (English-only source copy).
- Moondream community GGUF has degraded grounding accuracy; UI-TARS is the reliable grounding model.
