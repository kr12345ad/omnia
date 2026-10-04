import { animate } from "animejs"

const BLOCK_TAGS = new Set([
  "P",
  "LI",
  "PRE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "TABLE",
  "UL",
  "OL",
  "HR",
])

const FADED_LIMIT = 5000
const fadedByContainer = new WeakMap<HTMLElement, Set<string>>()

function reducedMotion(): boolean {
  if (typeof window === "undefined") return true
  if (typeof window.matchMedia !== "function") return true
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function blockKey(element: Element): string | undefined {
  const text = element.textContent?.trim().slice(0, 96)
  if (text === undefined || text.length === 0) return undefined
  return `${element.tagName}:${text}`
}

function fade(element: HTMLElement) {
  if (reducedMotion()) return
  animate(element, {
    opacity: [0, 1],
    translateY: [4, 0],
    duration: 340,
    ease: "outCubic",
  })
}

// Streamed markdown grows block by block. Newly inserted block-level elements
// fade in instead of popping in; blocks already rendered once are skipped so
// virtualized row remounts and re-renders never re-animate history. Keys are
// scoped to the container so identical text in different messages still fades.
export function observeMarkdownFade(container: HTMLElement): () => void {
  const faded = new Set<string>()
  fadedByContainer.set(container, faded)
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        // Markdown wraps each block in a display:contents div, so the block
        // elements are direct children. Walking only one level keeps streaming
        // cheap even for very long messages.
        const candidates = BLOCK_TAGS.has(node.tagName) ? [node, ...Array.from(node.children)] : Array.from(node.children)
        for (const child of candidates) {
          if (!(child instanceof HTMLElement) || !BLOCK_TAGS.has(child.tagName)) continue
          const key = blockKey(child)
          if (key === undefined || faded.has(key)) continue
          if (faded.size >= FADED_LIMIT) faded.clear()
          faded.add(key)
          fade(child)
        }
      }
    }
  })
  observer.observe(container, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    fadedByContainer.delete(container)
  }
}
