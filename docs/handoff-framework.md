# Omnia handoff framework

A file-backed, event-driven handoff layer for dormant sub-agents. The main agent
never runs a master-orchestrator loop: a local hook observes the result of a
shell tool, writes an execution packet, and wakes one short-lived specialist in
a child session. The specialist sends a summary back into the parent session's
normal message stream and exits.

This is the Omnia implementation of the Claude Code fork design. The names in
the original brief map onto this repository as follows:

| Brief / Claude Code            | Omnia                                                                 |
| ------------------------------ | --------------------------------------------------------------------- |
| `.claude/sessions/`             | `.omnia/sessions/<sessionID>/`                                        |
| `handoff.json`                  | `handoff.json`                                                        |
| `last_test_run.log`             | `last_test_run.log`                                                   |
| Bash tool wrapper               | `packages/opencode/src/session/tools.ts`                              |
| `SendMessage`                   | `send_message` tool                                                   |
| `triggerDormantAgent`           | `trigger_dormant_agent` tool                                          |
| Markdown frontmatter plugin     | `.omnia/agents/*.md`                                                  |
| Agent View / terminal UI        | the existing TUI / app session event stream                           |
| Hook injection module           | `packages/opencode/src/handoff/`                                      |

## 1. File infrastructure

Runtime state is project-local so a different process can hydrate an agent from
nothing but the workspace root and a session id.

```text
<project>/
└── .omnia/
    ├── .gitignore                 # sessions/, tasks/ (generated on first write)
    ├── agents/                    # committable dormant definitions
    │   └── log-analyzer.md
    └── sessions/
        └── <sessionID>/
            ├── handoff.json       # latest execution packet, atomic writes
            ├── last_test_run.log  # captured command output, 512 KiB tail
            └── inbox.jsonl        # delivery audit for cross-session messages
```

The `.omnia/sessions` directory is created only when a dormant agent actually
matches a trigger or a cross-session message is written. A normal failing test
in a project with no `.omnia/agents` does not create files and does not start a
model turn.

### Execution packet

`handoff.json` is validated with an Effect schema in
`packages/opencode/src/handoff/packet.ts` and written atomically (temporary file
plus rename).

```json
{
  "version": 1,
  "id": "6f2f0c9e-1a4f-4f2e-9b6a-0b7f3a0c2f11",
  "sessionID": "ses_01J...",
  "parentSessionID": "ses_01H...",
  "taskID": "ses_01K...",
  "agent": "log-analyzer",
  "status": "completed",
  "createdAt": "2026-10-31T09:14:03.112Z",
  "updatedAt": "2026-10-31T09:14:31.408Z",
  "trigger": {
    "kind": "test-failure",
    "command": "bun test src/cart.test.ts",
    "pattern": "(?:^|[\\s;&|()])(?:(?:bun|npm|...)"
  },
  "command": {
    "text": "bun test src/cart.test.ts",
    "shell": "bash",
    "cwd": "/home/me/app",
    "exitCode": 1,
    "timeout": 120000
  },
  "git": {
    "branch": "fix-cart-total",
    "head": "4c1a9de",
    "dirty": true,
    "files": ["src/cart.ts", "src/cart.test.ts"]
  },
  "tokens": {
    "input": 12040,
    "output": 1840,
    "reasoning": 302,
    "cacheRead": 48210,
    "cacheWrite": 0,
    "total": 62392
  },
  "targets": ["src/cart.ts", "src/cart.test.ts"],
  "log": "last_test_run.log",
  "summary": "The test expects a rounded total. cart.ts adds tax before rounding.",
  "next": ["log-analyzer"],
  "messages": [
    {
      "at": "2026-10-31T09:14:03.112Z",
      "role": "supervisor",
      "text": "Test command failed: bun test src/cart.test.ts"
    }
  ]
}
```

Fields are deliberately boring: strings, numbers, booleans and arrays only. The
packet survives JSON round-trips, is readable by `jq`, and can be consumed by a
separate supervisor process without importing Omnia code.

## 2. Hook interception pipeline

The existing shell tool is `packages/opencode/src/tool/shell.ts` (tool id
`bash`). Omnia does **not** patch the process spawn call. The interception point
is the tool wrapper in `packages/opencode/src/session/tools.ts`, immediately
after `item.execute(args, ctx)` and the plugin `tool.execute.after` hook:

```ts
if (item.id === ShellID.ToolID && instance) {
  const prepared = yield* Effect.promise(() =>
    Handoff.prepare({
      root: instance.worktree,
      session: {
        id: input.session.id,
        parentID: input.session.parentID,
        agent: input.session.agent,
        directory: input.session.directory,
        metadata: input.session.metadata,
      },
      tool: item.id,
      args: toRecord(args),
      result: { output: output.output, metadata: output.metadata },
      messages: input.messages,
    }),
  ).pipe(
    // A handoff is an optional side channel; a malformed agent file or an
    // unwritable .omnia directory must not fail a completed shell command.
    Effect.catchCause((cause) =>
      Effect.logWarning("handoff prepare failed", { cause }).pipe(Effect.as(undefined)),
    ),
  )
  if (prepared) run.fork(dispatch(prepared))
}
```

`Handoff.prepare` (`packages/opencode/src/handoff/index.ts`) applies all gates:

1. The tool is `bash`.
2. The session was not itself spawned by a handoff (`metadata.handoff` is
   absent). Regular subagents may escalate their own failing tests; this marker
   is the recursion boundary.
3. The exit code is a non-zero number.
4. The command matches `HandoffTrigger.TEST_COMMAND`. The regex only accepts
   package-manager and runner forms (`bun test`, `npm test`, `pnpm run
   test:unit`, `pytest`, `vitest`, `go test`, `cargo test`, `make test`,
   `node --test`, ...). A bare `test` argument such as `git commit -m test` does
   not wake an agent.
5. At least one dormant agent claims `test-failure` (or a `pattern:` trigger
   that matches the command).

If all gates pass:

- `result.metadata.outputPath` is preferred when the shell tool had to spill
  oversized output; otherwise the tool's own output is used.
- The tail of the output (up to 512 KiB) is written to
  `.omnia/sessions/<sessionID>/last_test_run.log` with a header containing the
  command, cwd, exit code and timestamp.
- Git branch, short HEAD and dirty files are collected with `git` invoked from
  the workspace root. Failure to read git is non-fatal.
- Token tallies are read from the last assistant message in the session history.
- The packet is written and the dispatcher is forked in the runtime bridge, so
  the main agent receives its tool result immediately.

The shell tool itself stays responsible for execution, truncation and streaming
metadata; the hook is a post-execution observer. That keeps the change small and
avoids coupling process spawning to agent orchestration.

## 3. Dormant registration and lazy loading

A dormant agent is a markdown file with frontmatter. Only files with
`dormant: true` are registered.

```markdown
---
description: Reads a failing test log and explains the first real failure.
dormant: true
agent: explore
triggers:
  - test-failure
  - "pattern:\\bcheckout\\b"
targets:
  - src/cart.ts
  - src/cart.test.ts
---

You are a failure analyst. Read the captured output, identify the first real
failure, and return a short diagnosis. Do not edit files.

Return:
1. Failure: the exact assertion or error, with file and line.
2. Cause: the smallest explanation that fits the evidence.
3. Fix: a concrete change and the file to touch.
4. Confidence: high, medium, or low.
```

Supported frontmatter fields:

| Field         | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `dormant`     | Must be `true` to be registered.                                        |
| `name`        | Registry name. Defaults to the file basename.                            |
| `description` | Human-readable purpose.                                                  |
| `agent`       | Existing Omnia agent used for hydration. Default `explore` (no edit/write tools; can search and run bash). |
| `triggers`    | `test-failure`, `manual`, `message`, `any`, or `pattern:<regex>`.        |
| `trigger`     | Singular alternative to `triggers`.                                      |
| `targets`     | File hints copied into the packet and prompt.                            |

### Why this is lazy

`HandoffDormant.scan` (`packages/opencode/src/handoff/dormant.ts`) scans
`.omnia/agents/**/*.md` and uses only the frontmatter; the body is not
evaluated or passed anywhere. It does **not**:

- call `Agent.Service.get`,
- build the system prompt,
- resolve model or provider settings,
- bind tools or permissions,
- allocate a child session,
- make a provider request.

The markdown body is re-read by `HandoffDormant.prompt` only when
`Handoff.run` has already created a child session and is about to hydrate the
agent. This is the cheap supervisor check the brief asks for: trigger matching
is a regex over a command and a frontmatter lookup, not an agent initialization.

`HandoffDormant.matches` treats an empty trigger list as `test-failure` and
supports `pattern:` triggers for teams that want a different failure class
(e.g. only checkout tests) without code changes.

## 4. Cross-session tools

Both tools are registered in `packages/opencode/src/tool/registry.ts` and use
the session prompt operations already available to every tool call
(`ctx.extra.promptOps`). They do not need a public HTTP route or an SDK
regeneration.

### `send_message`

Source: `packages/opencode/src/tool/send_message.ts`.

- `sessionID` defaults to the caller's immediate parent session, so a nested or
  background subagent reports upward without having to know an id.
- An explicit `sessionID` must resolve to an existing session in the same
  workspace; the caller cannot send to itself, and a root session without a
  parent gets an actionable error.
- The message is wrapped in a `<handoff_message>` envelope with the sender's
  session and agent.
- The full envelope is appended to the target's `inbox.jsonl` **before** the
  wake is scheduled. A wake can fail (busy run, provider error, cancellation)
  without losing the handoff message; the tool reports that the message was
  queued, not that the target has already answered.
- Delivery is a forked `ops.prompt({ sessionID, messageID, parts: [{ type:
  "text", text, synthetic: true }] })`. The tool returns immediately.
- The target receives ordinary `message.updated` and `message.part.updated`
  events. The TUI and app already subscribe to those events, so the message
  appears in the target's transcript without a new UI path, a blocking write, or
  a layout mutation.

The forked prompt is the same pattern the existing background `task` tool uses
for `injectBackgroundResult`, so it is serialized by the target session runner
and does not bypass cancellation or status handling.

### `trigger_dormant_agent`

Source: `packages/opencode/src/tool/trigger_dormant_agent.ts`.

- `agent` names a file under `.omnia/agents`.
- `reason` is written into the packet as the manual command.
- `wait: true` (default) runs the analysis in the foreground, does not append a
  duplicate result to the caller's inbox, and returns the summary as the tool
  result.
- `wait: false` forks the run and returns a receipt. The summary is delivered
  with `send_message`-style synthetic injection when the child finishes.
- It can be called from a root session or a regular task/discussion subagent,
  matching the automatic hook. A session that was itself spawned by a handoff
  carries `metadata.handoff` and is refused, so a specialist cannot chain
  another handoff; it should use `send_message` to report upward instead.

The tool shares the exact hydration path with the automatic hook
(`Handoff.run` in `packages/opencode/src/handoff/run.ts`), so manual and
automatic handoffs produce identical packets, child sessions and delivery
semantics.

## 5. The failure loop

1. **Main agent executes a failing test.**
   The model calls `bash` with `bun test src/cart.test.ts`. The shell tool
   spawns the command and returns a tool result with `metadata.exit = 1`.

2. **The wrapper flags the failure and writes logs.**
   `SessionTools` sees the `bash` result, calls `Handoff.prepare`, which writes
   `last_test_run.log` and `handoff.json` under
   `.omnia/sessions/<mainSessionID>/`. The main tool call returns normally.

3. **The analyzer hydrates and sends a summary.**
   `Handoff.run` creates a child session (`agent: explore`), marks the packet
   `running`, builds the static-plus-dynamic prompt, and calls
   `promptOps.prompt` for the child. The analyzer reads the log, produces the
   diagnosis, and the supervisor marks the packet `completed`. The summary is
   appended to `inbox.jsonl` and pushed into the main session with
   `synthetic: true`.

4. **The analyzer de-hydrates.**
   The child session runner reaches idle. There is no resident process, no
   in-memory specialist object, and no polling loop. The child transcript and
   token usage remain inspectable in the session list.

5. **The main agent receives the payload.**
   The synthetic `<handoff_result>` message is a normal user message. The main
   agent starts its next turn with the diagnosis and can apply the fix.

The dispatcher is forked, so steps 2 and 3 overlap: the main agent is free to
keep reasoning while the analyzer runs. If the main session is busy, the
injected result is serialized by the same session runner that handles
background subagent results.

## 6. Prompt caching

The analyzer prompt is assembled in
`packages/opencode/src/handoff/trigger.ts` in this order:

1. **Stable prefix** — role contract from the markdown body, workspace root,
   handoff session id, agent name, log filename, output contract. No timestamp,
   branch, command, packet id or log text.
2. **Dynamic suffix** — packet view, command, repository state, token tally,
   captured output tail.

Providers cache the longest matching prefix from the start of the request, so
the expensive role and workspace instructions are reused across failures while
only the packet and log tail are new. The static section is deterministic:
`staticContext` produces the same bytes for the same project/session/agent, and
the test in `packages/opencode/test/handoff/handoff.test.ts` asserts that.

Practical rules used here:

- The analyzer defaults to the `explore` agent, so its tool set is small and
  stable across runs (search, read and bash; no edit or write tool).
- The full log stays on disk. Only a 60 KiB tail enters the prompt; the prompt
  names the full file for follow-up reads.
- The static prefix contains no run identifiers. The packet id, branch, HEAD,
  exit code and timestamp live in the dynamic suffix.
- The child session is fresh each time, so the cache is a **prefix cache across
  sessions**, not a resumable conversation. Omnia's system prompt includes the
  current date; caches therefore have a natural daily boundary. That is
  expected, not a correctness issue.
- If a provider supports an explicit routing key (`promptCacheKey` for
  OpenAI/xAI), the child's stable system prompt and this prefix give the
  provider a consistent shard. Omnia does not send a per-packet key because the
  goal is to reuse the same prefix, not to isolate failures.

## 7. Operational notes

### Build and install

From `packages/opencode`:

```bash
bun run build --single --skip-install --skip-embed-web-ui
```

The compiled binary is written to `dist/opencode-<os>-<arch>/bin/opencode`. To
make it callable as `omnia`:

```bash
install -m 0755 dist/opencode-linux-x64/bin/opencode ~/.local/bin/omnia
omnia --version
```

`~/.local/bin` is already on the default PATH in this environment. The
`packages/opencode/package.json` `bin` map also exposes the same launcher as
`omnia` for package-manager installs.

### Tests

```bash
cd packages/opencode
bun typecheck
bun test test/handoff/handoff.test.ts
```

The tests cover trigger detection, dormant metadata scanning, packet/log writes,
inbox creation for a session that never failed a test, the no-agent,
subagent-trigger and handoff-recursion gates, static-prefix determinism,
`send_message` target resolution (parent default, explicit target, self-refusal
and no-parent guidance), and the foreground/background delivery split.

### Deliberate limits

- **One specialist per failure.** The dispatcher takes the first matching
  dormant agent. Multiple agents would multiply cost without a coordination
  policy; use a single analyzer that can fan out with `task` if needed.
- **Handoff-spawned sessions are the recursion boundary.** Regular task and
  discussion subagents may trigger a handoff; the specialist is created as a
  child of that subagent and its summary is delivered back into the subagent's
  message stream. A session spawned by a handoff carries `metadata.handoff` and
  never triggers another handoff, so chains stay one level deep.
- **Same project.** `send_message` writes its audit trail under the caller's
  workspace, and cross-project delivery is not a supported path in this
  version. Use a target session in the same workspace.
- **No durable retry after a crash.** A packet marked `running` is evidence,
  not a lease. A future supervisor can add a lease and a retry policy; the
  current design deliberately does not retry provider work after a crash.
- **Cost is still a model turn.** The framework removes the idle orchestrator,
  not the specialist's inference. Gate it with `.omnia/agents` presence, keep
  the analyzer's tool set narrow, and keep the log tail bounded.
- **The diagnosis is untrusted text.** A failing test can print adversarial
  content that reaches the analyzer, and the analyzer's summary is delivered to
  the parent as a synthetic user message. It is labelled and framed as agent
  output, not as a system instruction, but the parent should still treat file
  paths, commands and proposed edits as claims to verify. Keep the analyzer
  free of edit/write tools and review any tool call it initiates.
