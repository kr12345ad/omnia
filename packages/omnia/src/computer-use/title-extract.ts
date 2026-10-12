// Window-focus title candidates (FOCUS_ROLLOUT Phase 2).
// A focus intent like "focus kitty OC | Quick hello" carries a real window
// title inside command noise. The caller tries the most specific candidate
// first, then the fragments, and resolves by exact/substring/token match —
// never by semantic-clicking the window. Pure functions: no I/O, no imports.

const TITLE_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "window",
  "terminal",
  "app",
  "application",
  "please",
  "it",
  "this",
  "that",
])

// `|` plus the em/en dash, plus a spaced hyphen. An unspaced hyphen stays part
// of the title ("vim-notes" is one fragment).
const TITLE_SEPARATORS = /[|\u2014\u2013]|\s-\s/
const LEADING_TITLE_SEPARATORS = /^[\s|\u2014\u2013-]+/
const QUOTED_TITLE = /"([^"]*)"|'([^']*)'|\u201c([^\u201d]*)\u201d/g
const TITLE_HEAD_WORD = /\p{Lu}/u
const FOCUS_VERBS = new Set(["focus", "activate", "raise", "switch", "bring", "select"])
const MAX_TITLE_CANDIDATES = 8
const MAX_FULL_TITLE_CHARS = 120
const MIN_FRAGMENT_CHARS = 2
const MAX_COMMAND_WORDS_DROPPED = 3

export function extractTitleCandidates(text: string): readonly string[] {
  const full = text.trim()
  if (full.length < MIN_FRAGMENT_CHARS) return []
  // A quoted title names the window verbatim, so the command around it is
  // never split on `|`.
  const quoted = collectQuotedTitles(text)
  const commands = quoted.length === 0 ? commandPrefixViews(full) : []
  // An instruction longer than a title can be is a search string, not a title:
  // it keeps a slot only behind its fragments.
  const demoted = full.length > MAX_FULL_TITLE_CHARS && quoted.length === 0
  const titles = quoted.length > 0 ? [...quoted, full] : demoted ? commands : [full, ...commands]
  const fragments = quoted.length === 0 ? [full, ...commands].flatMap((source) => splitFragments(source)) : []
  const ordered = [...titles, ...fragments, ...(demoted ? [full] : [])]
  return dedupeCandidates(ordered).slice(0, MAX_TITLE_CANDIDATES)
}

export function titleTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0 && !TITLE_STOPWORDS.has(token))
}

// Jaccard overlap of title tokens. Both sides are deduplicated so the result
// stays inside 0..1; an empty token set on either side scores 0.
export function titleOverlap(query: string, title: string): number {
  const queryTokens = new Set(titleTokens(query))
  const titleTokensSet = new Set(titleTokens(title))
  const union = new Set([...queryTokens, ...titleTokensSet])
  if (union.size === 0) return 0
  const shared = [...queryTokens].filter((token) => titleTokensSet.has(token)).length
  return shared / union.size
}

function collectQuotedTitles(text: string): string[] {
  const titles: string[] = []
  for (const match of text.matchAll(QUOTED_TITLE)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim()
    if (value.length >= MIN_FRAGMENT_CHARS) titles.push(value)
  }
  return titles
}

function splitFragments(view: string): string[] {
  return view
    .split(TITLE_SEPARATORS)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= MIN_FRAGMENT_CHARS)
}

// "focus kitty OC | Quick hello" hides the window title behind a command.
// Command words are dropped one at a time until the next word looks like the
// title itself — capitalized, or holding a separator — which surfaces
// "OC | Quick hello" without treating "focus kitty" as part of the title.
function commandPrefixViews(full: string): string[] {
  const words = full.split(/\s+/).filter((word) => word.length > 0)
  const start = commandPrefixStart(words)
  if (start === undefined) return []
  const views: string[] = []
  for (let index = start; index < words.length; index++) {
    if (index > start && looksLikeTitleHead(words[index])) break
    if (views.length >= MAX_COMMAND_WORDS_DROPPED) break
    const view = words
      .slice(index + 1)
      .join(" ")
      .replace(LEADING_TITLE_SEPARATORS, "")
      .trim()
    if (view.length >= MIN_FRAGMENT_CHARS) views.push(view)
  }
  return views
}

// Only a text that opens like a focus instruction loses leading words: an
// optional "please", then a focus verb. "OC | Quick hello" and "vim-notes - OC"
// are titles as written and keep their first word.
function commandPrefixStart(words: readonly string[]): number | undefined {
  const lead = words[0]?.toLowerCase()
  if (lead === "please") return FOCUS_VERBS.has(words[1]?.toLowerCase() ?? "") ? 1 : undefined
  return FOCUS_VERBS.has(lead) ? 0 : undefined
}

function looksLikeTitleHead(word: string): boolean {
  return TITLE_SEPARATORS.test(word) || TITLE_HEAD_WORD.test(word)
}

function dedupeCandidates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = value.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
