// Looping anime.js timelines keep ticking while the window is hidden. Pausing
// them on visibilitychange keeps background windows (and the many small
// indicators they render) from burning CPU for animations nobody can see.
export function observeAnimationVisibility(
  animations: () => readonly { pause: () => unknown; play: () => unknown }[],
): () => void {
  const update = () => {
    const hidden = typeof document !== "undefined" && document.visibilityState !== "visible"
    for (const animation of animations()) {
      if (hidden) animation.pause()
      else animation.play()
    }
  }
  if (typeof document === "undefined") return () => undefined
  document.addEventListener("visibilitychange", update)
  update()
  return () => document.removeEventListener("visibilitychange", update)
}
