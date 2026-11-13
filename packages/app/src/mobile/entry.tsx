// @refresh reload

import { render } from "solid-js/web"
import { ChatApp } from "../chat/app"
import { chatAuthHeaders, chatPageBase, clearChatAuthToken, resolveChatServer } from "../chat/server"
import "../index.css"

const root = document.getElementById("root")

if (root instanceof HTMLElement) {
  const params = new URLSearchParams(location.search)
  const token = params.get("auth_token")
  const headers = chatAuthHeaders(token)
  // The token is read once for this tab; keep it out of the address bar and
  // out of any link copied from it.
  clearChatAuthToken()

  const baseUrl = resolveChatServer({
    param: params.get("server"),
    injected: (globalThis as { __OMNIA_SERVER_URL__?: unknown }).__OMNIA_SERVER_URL__,
    // `/mobile` and `/mobile.html` are the mobile entry, so strip them the same
    // way `chatPageBase` strips `/chat` before deriving the server base.
    origin: chatPageBase({ origin: location.origin, pathname: location.pathname }),
    dev: import.meta.env.DEV
      ? {
          host: import.meta.env.VITE_OPENCODE_SERVER_HOST,
          port: import.meta.env.VITE_OPENCODE_SERVER_PORT,
        }
      : undefined,
  })

  // `null` starts on the session list (the drawer) instead of auto-opening the
  // newest session, so the first mobile screen after pairing is Sessions.
  render(() => <ChatApp baseUrl={baseUrl} headers={headers} initialSessionID={null} />, root)
}
