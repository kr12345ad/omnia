export const normalizeModelSearch = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")

export const compactModelSearch = (value: string) => normalizeModelSearch(value).replaceAll(" ", "")

export const matchesModelSearch = (query: string, values: string[]) => {
  const search = normalizeModelSearch(query)
  if (!search) return true

  const compactSearch = compactModelSearch(query)
  return values.some(
    (value) => normalizeModelSearch(value).includes(search) || compactModelSearch(value).includes(compactSearch),
  )
}

// Provider names are already in the group header, so model names carry them
// twice ("DeepSeek V4.1 Flash Max"). The list and the composer show the short
// form: the company name stripped, keeping the full name for titles.
export const modelDisplayName = (model: { name: string; provider: { name: string } }) => {
  const prefix = `${model.provider.name} `
  if (model.name.toLowerCase().startsWith(prefix.toLowerCase())) return model.name.slice(prefix.length).trim()
  return model.name
}

// Stealth (and other unbranded) models have no logo in the pack. Show one
// letter, preferring the word after "Stealth" ("Stealth Z" -> "Z", "Stealth G"
// -> "G") and otherwise the first letter of the display name.
export const modelLetterFallback = (model: { name: string; provider: { name: string } }) => {
  const display = modelDisplayName(model)
  const stealth = /^stealth\s+(.)/i.exec(display)
  if (stealth) return stealth[1]!.toUpperCase()
  return display.charAt(0).toUpperCase() || "?"
}

// Gateways resell models from many AI companies. For those providers the
// branding that matters is the company that made the model, not the gateway,
// so the icon and grouping follow the model's vendor.
export const MODEL_GATEWAY_PROVIDERS = new Set([
  "opencode",
  "opencode-go",
  "openrouter",
  "vercel",
  "synthetic",
  "requesty",
  "helicone",
  "zenmux",
])

const MODEL_VENDOR_RULES: { pattern: RegExp; vendor: string }[] = [
  { pattern: /\bbeam\b/i, vendor: "beam" },
  { pattern: /\breflection\b/i, vendor: "reflection" },
  { pattern: /deepseek/i, vendor: "deepseek" },
  { pattern: /longcat/i, vendor: "longcat" },
  { pattern: /\b(glm|zhipu|chatglm|z-ai)\b/i, vendor: "zai" },
  { pattern: /\b(kimi|moonshot)\b/i, vendor: "kimi" },
  { pattern: /\bminimax\b/i, vendor: "minimax" },
  { pattern: /\b(qwen|tongyi)\b/i, vendor: "qwen" },
  { pattern: /\b(doubao|bytedance|seed-oss)\b/i, vendor: "doubao" },
  { pattern: /\b(hunyuan|tencent)\b/i, vendor: "hunyuan" },
  { pattern: /\b(ernie|wenxin|baidu)\b/i, vendor: "wenxin" },
  { pattern: /\b(llama|meta)\b/i, vendor: "meta" },
  { pattern: /\b(grok|xai)\b/i, vendor: "xai" },
  { pattern: /\b(mistral|mixtral|codestral|devstral|magistral|pixtral)\b/i, vendor: "mistral" },
  { pattern: /\bclaude\b/i, vendor: "anthropic" },
  { pattern: /\b(gpt|openai|codex|o[34](-|$|mini|pro))/i, vendor: "openai" },
  { pattern: /\b(gemini|gemma|google)\b/i, vendor: "google" },
  { pattern: /\b(nemotron|nvidia)\b/i, vendor: "nvidia" },
  { pattern: /\b(command-r|cohere)\b/i, vendor: "cohere" },
  { pattern: /\bnova\b/i, vendor: "nova" },
  { pattern: /\b(sonar|perplexity)\b/i, vendor: "perplexity" },
  { pattern: /\b(ai21|jamba)\b/i, vendor: "ai21" },
  { pattern: /\breka\b/i, vendor: "reka" },
  { pattern: /\b(upstage|solar-)\b/i, vendor: "upstage" },
  { pattern: /\b(liquid|lfm)\b/i, vendor: "liquid" },
  { pattern: /\barcee\b/i, vendor: "arcee" },
  { pattern: /\b(nous|hermes)\b/i, vendor: "nousresearch" },
  { pattern: /\b(kling|kuaishou)\b/i, vendor: "kling" },
  { pattern: /\b(stepfun|step-)\b/i, vendor: "stepfun" },
  { pattern: /\binternlm\b/i, vendor: "internlm" },
  { pattern: /\bbaichuan\b/i, vendor: "baichuan" },
  { pattern: /\b(yi-|01\.ai|01ai)\b/i, vendor: "yi" },
  { pattern: /\b(phi-|microsoft)\b/i, vendor: "microsoft" },
  { pattern: /\b(granite|ibm)\b/i, vendor: "ibm" },
  { pattern: /\b(olmo|allenai)\b/i, vendor: "allenai" },
]

// The AI company behind one model, when it can be recognized from its id or
// name. Undefined means stealth or unlabelled: fall back to a letter.
export const modelVendor = (model: { id?: string; name: string }) => {
  const haystack = `${model.id ?? ""} ${model.name}`
  for (const rule of MODEL_VENDOR_RULES) {
    if (rule.pattern.test(haystack)) return rule.vendor
  }
  return undefined
}

// Per-million-token input/output price, straight from models.dev. Whole
// dollars stay whole; fractions keep two trimmed decimals. Free (both zero)
// returns undefined because the Free tag already says it.
export const modelPriceLabel = (cost?: { input?: number; output?: number }) => {
  const input = cost?.input
  const output = cost?.output
  if (typeof input !== "number" || typeof output !== "number") return undefined
  if (input === 0 && output === 0) return undefined
  const amount = (value: number) =>
    Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}`
  return `${amount(input)}/${amount(output)}`
}
