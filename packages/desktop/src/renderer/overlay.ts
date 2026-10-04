// Pause the ring animation while the overlay window is hidden so an idle
// desktop never pays for compositing work.
const sync = () => {
  document.documentElement.classList.toggle("overlay-paused", document.visibilityState !== "visible")
}

document.addEventListener("visibilitychange", sync)
sync()
