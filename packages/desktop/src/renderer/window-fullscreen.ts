import { createSignal } from "solid-js"

const [windowFullscreen, setWindowFullscreen] = createSignal(false)

// A renderer reload keeps the native window state, so seed from the main
// process instead of assuming a windowed window. Once main pushes a change it
// is newer than the in-flight read and must win.
let pushed = false

window.api.onWindowFullscreenChanged((fullscreen) => {
  pushed = true
  setWindowFullscreen(fullscreen)
})

void window.api
  .getWindowFullscreen()
  .then((fullscreen) => {
    if (pushed) return
    setWindowFullscreen(fullscreen)
  })
  .catch(() => undefined)

export { windowFullscreen }