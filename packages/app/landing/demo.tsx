// Landing-page demo entry.
//
// The marketing site must not hand-fake the product: this mounts the same
// SessionTurn component, same message part renderers, same tool cards and the
// same theme the desktop app uses, fed curated (invented) session data. The
// scenarios below are written to be representative of real Omnia turns, not to
// be real transcripts.
import { render } from "solid-js/web"
import { MetaProvider } from "@solidjs/meta"
import { Font } from "@opencode-ai/ui/font"
import { ThemeProvider, useTheme } from "@opencode-ai/ui/theme"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { DataProvider } from "@opencode-ai/session-ui/context/data"
import { SessionTurn } from "@opencode-ai/session-ui/session-turn"

import "@opencode-ai/ui/styles/tailwind"
import "@opencode-ai/session-ui/styles"
import "@opencode-ai/ui/v2/styles/tailwind.css"

type ToolSample = {
  tool: string
  input: Record<string, unknown>
  output: string
  title: string
  metadata?: Record<string, unknown>
}

let seq = 0
const uid = (prefix: string) => `${prefix}-${++seq}`

const SESSION_ID = "ses_landing"

function textPart(text: string) {
  return { id: uid("prt"), type: "text", text, time: { created: Date.now() } } as never
}

function reasoningPart(text: string) {
  return { id: uid("prt"), type: "reasoning", text, time: { start: Date.now(), end: Date.now() + 400 } } as never
}

function toolPart(sample: ToolSample, status: "completed" | "running" = "completed") {
  const base = { id: uid("prt"), type: "tool" as const, callID: uid("call"), tool: sample.tool }
  if (status === "running") {
    return {
      ...base,
      state: { status: "running", input: sample.input, title: sample.title, metadata: sample.metadata ?? {}, time: { start: Date.now() } },
    } as never
  }
  return {
    ...base,
    state: {
      status: "completed",
      input: sample.input,
      output: sample.output,
      title: sample.title,
      metadata: sample.metadata ?? {},
      time: { start: Date.now(), end: Date.now() + 900 },
    },
  } as never
}

// The assistant reply is found by parentID, not by being "the next message":
// without it SessionTurn renders the prompt and nothing else.
function assistantMessage(parentID: string) {
  return {
    id: uid("msg"),
    sessionID: SESSION_ID,
    role: "assistant" as const,
    parentID,
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    mode: "default",
    agent: "agent",
    path: { cwd: "/project", root: "/project" },
    time: { created: Date.now(), completed: Date.now() + 4000 },
  }
}

function session(title: string) {
  return {
    id: SESSION_ID,
    title,
    time: { created: Date.now(), updated: Date.now() },
  } as never
}

// ---------------------------------------------------------------------------
// Scenario 1 — desktop control, with the verification the runtime really does
// ---------------------------------------------------------------------------
// Tool ids and input shapes mirror the registered computer tool cards, so the
// timeline renders them with the real renderers rather than a generic fallback.
const CONTROL_TOOLS: ToolSample[] = [
  {
    tool: "computer_find",
    input: { query: "Save button", role: "push button" },
    output: 'Found 2 candidates:\nsoffice "Save" (push button, atspi:14) — 0.94\nsoffice "Save As" (push button, atspi:15) — 0.61',
    title: "Found 2 candidates",
    metadata: { best: { name: "Save" }, candidates: 2 },
  },
  {
    tool: "computer_act",
    input: { action: "click", target: "atspi:14", observationId: "obs-2f41" },
    output: "Clicked push button “Save”. Pointer moved to (842, 96).",
    title: "Clicked Save",
    metadata: {
      action: "click",
      targetName: "Save",
      success: true,
      verification: { status: "verified", method: "atspi-focus", detail: "focus landed on the Save button" },
    },
  },
  {
    tool: "computer_act",
    input: { action: "type", target: "atspi:31", text: "quarterly-forecast.ods" },
    output: "Typed 22 characters into the file name field, then read them back: quarterly-forecast.ods",
    title: "Typed into “Name”",
    metadata: {
      action: "type",
      targetName: "Name",
      success: true,
      verification: {
        status: "verified",
        method: "observation-readback",
        detail: "read back “quarterly-forecast.ods” from the field",
      },
    },
  },
  {
    tool: "computer_screenshot",
    input: {},
    output: "Captured 1920x1080. Saved to ~/.omnia/screenshots/step-4.png (sha256 4f9c…a12e).",
    title: "Captured the screen",
    metadata: { width: 1920, height: 1080 },
  },
]

// ---------------------------------------------------------------------------
// Scenario 2 — the embedded browser, driven the way a person drives it
// ---------------------------------------------------------------------------
const BROWSER_TOOLS: ToolSample[] = [
  {
    tool: "computer_browser",
    input: { action: "open", url: "https://example.com/account/delete" },
    output: '{"id":"tab-3","url":"https://example.com/account/delete","title":"Delete account"}',
    title: "Opened a tab",
    metadata: { tab: { id: "tab-3" } },
  },
  {
    tool: "computer_browser",
    input: { action: "find", query: "Delete this account" },
    output: "1 candidate: button “Delete this account” @doc-91",
    title: "Found 1 candidate",
    metadata: {},
  },
  {
    tool: "computer_browser",
    input: { action: "click", target: "button-1@doc-91", expectedType: "confirm" },
    output: "Clicked. A confirm dialog opened; answered it with dismiss.",
    title: "Clicked, then answered the confirm",
    metadata: {},
  },
  {
    tool: "computer_browser",
    input: { action: "type", target: "field-1@pw", credential: "example-portal" },
    output: "Typed the stored credential into the password field, then read the field back as non-empty. The secret never entered the model context.",
    title: "Typed a stored credential",
    metadata: {
      verification: { status: "verified", method: "browser-value-readback", detail: "the field reports a non-empty value" },
    },
  },
]

// ---------------------------------------------------------------------------
// Scenario 3 — a risky step that stopped for a human
// ---------------------------------------------------------------------------
const APPROVAL_TOOLS: ToolSample[] = [
  {
    tool: "computer_act",
    input: { action: "launch_app", app: "postgresql" },
    output: "Refused: starting a process needs the PROCESS_EXECUTE scope, which this session has not been granted. Nothing was launched.",
    title: "Held for approval",
    metadata: {
      action: "launch_app",
      targetName: "postgresql",
      success: false,
      verification: { status: "unverified", method: "none", detail: "refused until a human approves the scope" },
    },
  },
  {
    tool: "computer_act",
    input: { action: "launch_app", app: "postgresql" },
    output: "Approved by session:operator (PROCESS_EXECUTE, fingerprint 57286e74). Started postgresql; the service window appeared on display :0.",
    title: "Re-ran with approval",
    metadata: {
      action: "launch_app",
      targetName: "postgresql",
      success: true,
      verification: { status: "verified", method: "observation-readback", detail: "window appeared in the fresh observation" },
    },
  },
]

function scenario(tools: ToolSample[], prompt: string, answer: string, thinking: string) {
  const userMessageID = uid("msg")
  const reply = assistantMessage(userMessageID)
  const parts: Record<string, unknown[]> = {
    [userMessageID]: [{ id: uid("prt"), type: "text", text: prompt, time: { created: Date.now() } }],
    [reply.id]: [reasoningPart(thinking), ...tools.map((tool) => toolPart(tool)), textPart(answer)],
  }
  return {
    data: {
      session: [session(prompt.slice(0, 48))],
      session_status: { [SESSION_ID]: { type: "idle" as const } },
      session_diff: { [SESSION_ID]: [] },
      message: {
        [SESSION_ID]: [
          { id: userMessageID, sessionID: SESSION_ID, role: "user" as const, time: { created: Date.now() } },
          reply,
        ],
      },
      part: parts,
    },
    userMessageID,
  } as never as { data: never; userMessageID: string }
}

const SCENES = {
  control: scenario(
    CONTROL_TOOLS,
    "Export the current sheet as quarterly-forecast.ods on the Desktop and confirm it saved.",
    "Saved it. The dialog reported a verified read-back of the file name, and the screenshot shows “quarterly-forecast.ods” in the title bar.",
    "The LibreOffice window is the only editor open. I'll reuse its Save As dialog rather than launching a second instance.",
  ),
  browser: scenario(
    BROWSER_TOOLS,
    "Check what the account deletion page actually does when you confirm, and log in with the stored portal credential if it asks.",
    "Nothing destructive happened: the page only simulates deletion. The credential was typed by the machine, and the field read back non-empty before I continued.",
    "The page has a confirm dialog. I'll answer it and read the page back rather than trusting the click alone.",
  ),
  approval: scenario(
    APPROVAL_TOOLS,
    "Restart postgres so the new config takes effect.",
    "Started. It stopped for approval first — launching a process needs PROCESS_EXECUTE, and nothing ran until the scope was granted.",
    "This starts a process on the host, so it has to stop for approval. There is no path where I launch it silently.",
  ),
} as const

export type SceneName = keyof typeof SCENES

function Scheme() {
  const theme = useTheme()
  theme.setColorScheme("dark")
  const root = document.documentElement
  root.classList.remove("light", "dark")
  root.classList.add(theme.mode())
  document.body.toggleAttribute("data-new-layout", true)
  document.body.classList.add("font-(family-name:--font-family-text)", "text-[13px]", "font-[440]")
  document.body.classList.remove("text-12-regular")
  return null
}

function FileStub() {
  return <span />
}

function Scene(props: { name: SceneName }) {
  const scene = SCENES[props.name]
  return (
    <DataProvider data={scene.data} directory="/project">
      <FileComponentProvider component={FileStub as never}>
        <div role="log" data-slot="session-turn-list" style={{ display: "flex", "flex-direction": "column", width: "100%" }}>
          <SessionTurn
            sessionID={SESSION_ID}
            messageID={scene.userMessageID}
            messages={(scene.data as { message: Record<string, never[]> }).message[SESSION_ID]! as never}
            active={false}
            showReasoningSummaries={true}
            shellToolDefaultOpen={true}
            editToolDefaultOpen={true}
            classes={{ root: "min-w-0 w-full relative", content: "flex flex-col justify-between !overflow-visible", container: "w-full" }}
          />
        </div>
      </FileComponentProvider>
    </DataProvider>
  )
}

let dispose: (() => void) | undefined

function mount(target: HTMLElement, name: SceneName) {
  // Switching scenes re-renders the same host element; without disposing the
  // previous root its effects and listeners survive the swap.
  dispose?.()
  target.innerHTML = ""
  dispose = render(
    () => (
      <MetaProvider>
        <Font />
        <ThemeProvider>
          <Scheme />
          <DialogProvider>
            <MarkedProvider>
              <Scene name={name} />
            </MarkedProvider>
          </DialogProvider>
        </ThemeProvider>
      </MetaProvider>
    ),
    target,
  )
  return dispose
}

declare global {
  interface Window {
    OmniaDemo?: { mount: (target: HTMLElement, name: SceneName) => void; scenes: SceneName[] }
  }
}

window.OmniaDemo = { mount, scenes: Object.keys(SCENES) as SceneName[] }
