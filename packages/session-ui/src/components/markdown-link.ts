// The label a link chip shows.
//
// A markdown link already carries a title ("the docs", "pricing"), and that is
// what a reader needs. When the label is the URL itself — which is what happens
// every time a model writes a bare link — showing it in full leaves a long
// trailing string in the middle of a sentence. In that case the host is the
// title people recognize, and the full URL stays available in the tooltip.
const URL_LIKE = /^https?:\/\/\S+$/i

export function linkChipLabel(text: string, href: string): string {
  const label = text.trim()
  if (label.length > 0 && !URL_LIKE.test(label)) return label
  const host = hostname(href)
  if (host !== undefined) return host
  return label.length > 0 ? label : href
}

function hostname(href: string): string | undefined {
  const url = URL.parse(href)
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return undefined
  const host = url.hostname.replace(/^www\./i, "")
  return host.length > 0 ? host : undefined
}
