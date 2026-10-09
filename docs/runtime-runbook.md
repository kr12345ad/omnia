# Omnia Runtime Runbook

Per-platform smoke procedure for the local computer runtime. Run the steps for
the platform under test after a build; each step ends with a **fail-closed**
check: an action is only a pass when the runtime returned `success: true` **and**
`verification.status === "verified"`. Anything else is a failure, even when the
UI appears to have changed.

The desktop app starts the local Omnia server and writes connection details to
`server.json` in the app `userData` directory:

```json
{ "url": "http://127.0.0.1:PORT", "token": "...", "serverId": "...", "computerId": "..." }
```

Use it for the API smoke commands below:

For standalone deployments, credentials supplied in `OMNIA_SERVER_TOKEN` stay
in the operator's secret configuration. An automatically generated token is
written to `OMNIA_SERVER_INFO_FILE` (default `./omnia-server-info.json`) with
private permissions; it is no longer printed to stdout. Protect these files and
exclude them from diagnostic exports. Omnia's HTTP listener binds to loopback;
remote access must use an HTTPS proxy/tunnel. Discovery is opt-in.

CORS defaults to `oc://renderer` and the configured public URL's origin.
Standalone deployments may supply exact origins in `OMNIA_CORS_ORIGINS`.
Do not use `*` or `null`. Preflight from an allowed origin does not authorize
the actual request; it still requires a bearer credential.

```sh
BASE=$(jq -r .url "$USERDATA/server.json")
TOKEN=$(jq -r .token "$USERDATA/server.json")
COMPUTER=$(jq -r .computerId "$USERDATA/server.json")
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/computers/$COMPUTER/capabilities" | jq
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{}' "$BASE/v1/computers/$COMPUTER/observe" | jq '.observation.warnings, (.observation.elements | length)'
```

## Logs and diagnostics

| Source | Location / command |
| --- | --- |
| Desktop logs | `userData/logs/<timestamp>/`, one `.log` per scope (main, renderer, omnia) |
| Full debug bundle | In-app "Export debug logs", or `exportDebugLogs()`; writes `~/Downloads/opencode-debug-<stamp>.zip` |
| Server logs | `$XDG_DATA_HOME/opencode/log` (Linux) or `userData/opencode/log` |
| Security journal | `OMNIA_AUDIT_FILE`, or `audit/<server-id>.jsonl` alongside the Omnia auth file; private JSONL/HMAC-chain records |
| macOS AX helper | `ls -l ~/.omnia/bin/ax-helper`; bypass with `OMNIA_AX_HELPER=/path/to/ax-helper` |
| Linux AT-SPI helper | Warnings arrive inside the observation; run `python3 -c "import pyatspi; print('ok')"` to reproduce |
| Windows UIA probe | `powershell.exe -NoProfile -Command "Add-Type -AssemblyName UIAutomationClient; 'ok'"` |

Always capture the observation `warnings` array and the capability list next to
the raw log excerpt; a refusal without them is not diagnosable.

## Linux — X11

Expected: `DISPLAY` set, `xprop`/`xwininfo`/`xrandr` installed, `python3` with
`pyatspi`, `libXtst`/`libX11` for XTest, and `spectacle` or `ffmpeg` for
screenshots.

1. `echo "$DISPLAY"` is non-empty and `xdpyinfo | head` succeeds.
2. `python3 -c "import pyatspi; print('ok')"` prints `ok`.
3. `ldconfig -p | grep -E 'libXtst|libX11'` lists both.
4. Start the app; call `/v1/computers/<id>/observe`; expect `elements` with
   window entries. If the accessibility tree is empty, the observation warning
   names the AT-SPI failure and `capabilities.accessibility` is `unavailable`.
5. Semantic action smoke: launch the target app, `POST .../find` with
   `{"query":"<control>"}`, then `POST .../actions` with
   `{"action":"click","target":{"elementId":"<ref>"}}` using the returned ref.
6. Screenshot smoke: `POST .../actions` with `{"action":"screenshot"}`; the
   result metadata carries a path whose size is non-zero.

Fail-closed: window geometry that cannot be read produces no window (not a
`(0,0)` click target); a dead `DISPLAY` (socket gone) reports the driver
unavailable instead of claiming capabilities.

## Linux — Wayland

Expected: `WAYLAND_DISPLAY` set, `grim` (or `spectacle`) for capture, and
`ydotool` plus a running `ydotoold` daemon for input.

1. `echo "$WAYLAND_DISPLAY"` is non-empty; `grim -pg` writes a test screenshot.
2. `ydotool type ""` exits 0 (probe); if it fails, keyboard/pointer are
   `degraded` and native Wayland windows cannot receive synthetic input.
3. Start the app and observe. Native Wayland apps appear through AT-SPI only;
   there is no X11 window list.
4. Pointer-position reads and window management on native Wayland tasks are
   expected to refuse (`operation_unavailable`) — this is fail-closed, not a
   bug.

## macOS

Grants (System Settings > Privacy & Security):

| Grant | Needed for | Notes |
| --- | --- | --- |
| Accessibility | AX snapshots, semantic actions, synthetic input | Prompted on app start (`isTrustedAccessibilityClient(true)`); the native helper needs only this |
| Screen Recording | `screencapture` screenshots | Missing grant yields a screenshot refusal |
| Automation (Apple Events) | System Events / JXA fallback only | Snapshots prefer the native AX helper and do **not** require Automation |

Native AX helper:

1. `swiftc --version` works, or the packaged app ships `resources/mac/ax-helper`.
2. If neither exists, the runtime compiles `~/.omnia/bin/ax-helper.swift` on
   first use; `ls -l ~/.omnia/bin/ax-helper` should show a fresh executable.
3. `OMNIA_AX_HELPER=/path/ax-helper` overrides both.

Smoke steps:

1. Grant Accessibility; restart the app.
2. `ioreg -l -d 1 -k CGSSessionSecureInputPID` — if it reports a PID, Secure
   Input is active.
3. `POST .../observe`; elements should carry `metadata.backend: "macos-ax"`.
   An error mentioning `Automation`/`System Events` means only the JXA fallback
   is blocked; grant Automation or confirm the helper is present.
4. Type smoke: focus a text field and send `{"action":"type","text":"omnia"}`.
   While Secure Input is active, keyboard actions must refuse with
   `error.code: "secure_input"` (finish the secure prompt or disable Secure
   Keyboard Entry and retry).
5. Screenshot smoke: `{"action":"screenshot"}` with Screen Recording granted.

Fail-closed: element targets that cannot be located refuse with `target_stale`
instead of typing into whatever is frontmost; a failed AX walk never falls back
to a global keystroke.

## Windows

Expected: an interactive desktop session (not a service session), PowerShell on
`PATH`, and UI Automation available (`UIAutomationClient`).

1. `powershell.exe -NoProfile -Command "Add-Type -AssemblyName UIAutomationClient; 'ok'"` prints `ok`.
2. Start the app; `GET .../capabilities` should report `cua_snapshot` and
   `windows-uia` capabilities as `available`.
3. `POST .../observe`; elements carry `metadata.backend: "windows-uia"`.
   If the probe fails, the CUA engine is unavailable and the legacy PowerShell
   driver still serves the surface — the warnings say why.
4. Semantic action smoke: launch Notepad, locate a `textbox` with `/find`, then
   `POST .../actions` with
   `{"action":"type","target":{"elementId":"<ref-from-find>"},"text":"omnia"}`.
5. Elevated windows: background actions refuse unless Omnia runs elevated;
   foreground pointer/keyboard fallback is opt-in.

## Fail-closed verification matrix

| Signal | Meaning | Required operator action |
| --- | --- | --- |
| `verification.status: "verified"` | The runtime re-observed and proved the change | Pass |
| `verification.status: "unverified"` / `"failed"` | Delivery not proven | Treat as failure; capture observation + logs |
| `error.code: "target_stale"` | Bound element/generation is gone | Re-observe, re-find, retry |
| `error.code: "secure_input"` (macOS) | System discards synthetic keys | Finish/disable the secure prompt |
| `error.code: "capture_stale"` (CUA) | Action referenced an older snapshot | Take a fresh snapshot |
| `error.code: "operation_unavailable"` | Capability not supported here | Do not retry blindly; fix prerequisites |
| `error.code: "invalid_cwd"` / `"invalid_env"` | `run_command` boundary refused the request | Fix the request; do not bypass |
| `metadata.error: "snapshot_failed"` | Empty tree is engine failure | Never read as a blank desktop |

The Linux and macOS `run_command` shells reject malformed environment entries
and overrides of `PATH`, `DISPLAY`, `LD_*`, `DYLD_*`, `BUN_*`, shell startup
variables (`BASH_ENV`, `ENV`, `SHELLOPTS`), and Node/Python/Ruby/Perl startup
variables. This is environment validation, not an OS sandbox: approved commands
still execute as the runtime's OS user. Command output is capped
(`maxOutputBytes`, default 256 KiB, hard cap 1 MiB), timeouts run
`SIGTERM` → `SIGKILL`, and stdin write failures surface as
`command.stdinError`.
