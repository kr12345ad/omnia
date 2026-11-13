// @refresh reload

import { render } from "solid-js/web"
import { ChatApp } from "./app"
import { chatAuthHeaders, chatPageBase, clearChatAuthToken, resolveChatServer } from "./server"
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
    origin: chatPageBase({ origin: location.origin, pathname: location.pathname }),
    dev: import.meta.env.DEV
      ? {
          host: import.meta.env.VITE_OPENCODE_SERVER_HOST,
          port: import.meta.env.VITE_OPENCODE_SERVER_PORT,
        }
      : undefined,
  })

  render(() => <ChatApp baseUrl={baseUrl} headers={headers} />, root)
}
