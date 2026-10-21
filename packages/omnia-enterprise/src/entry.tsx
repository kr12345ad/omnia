// @refresh reload

import { render } from "solid-js/web"
import "./index.css"
import { App } from "@/app"
import { SessionProvider, ToastProvider } from "@/state"

const root = document.getElementById("root")
if (root instanceof HTMLElement) {
  render(
    () => (
      <ToastProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </ToastProvider>
    ),
    root,
  )
}
