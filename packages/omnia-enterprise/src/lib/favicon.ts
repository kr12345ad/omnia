/**
 * The console's tab carries the operator's mark once they have set one.
 *
 * The shipped link and any shortcut link are removed rather than only rewritten:
 * browsers are free to pick any declared icon, and the document's static link
 * (or an older branded one) resolving to a 404 is what leaves the tab blank.
 * The type is cleared too, because the shipped link declares an SVG and a PNG
 * the operator uploaded would otherwise be filtered out by that declaration.
 */
export function setFavicon(url: string | undefined) {
  const text = url?.trim()
  if (text === undefined || text.length === 0 || typeof document === "undefined") return
  document
    .querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="shortcut icon"]')
    .forEach((link) => link.remove())
  const link = document.createElement("link")
  link.rel = "icon"
  link.href = text
  document.head.append(link)
}
