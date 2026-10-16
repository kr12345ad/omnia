import { describe, expect, test } from "bun:test"
import {
  OPENUI_COMPONENTS,
  OPENUI_EXTENSION_COMPONENTS,
  OPENUI_EXTENSION_PROMPT,
  OPENUI_EXTENSION_SIGNATURES,
  OPENUI_SCHEMA,
  OPENUI_SYSTEM_PROMPT,
  isOpenUIElement,
  mergeOpenUISchema,
} from "@opencode-ai/core/openui"
import { createParser, createStreamingParser } from "@openuidev/lang-core"

type ParserSchema = Parameters<typeof createParser>[0]
const parserSchema = OPENUI_SCHEMA as unknown as ParserSchema
const parse = (program: string) => createParser(parserSchema, "Stack").parse(program)

const names = Object.keys(OPENUI_COMPONENTS)

describe("openui library", () => {
  test("the schema declares exactly the components the prompt documents", () => {
    expect(OPENUI_SCHEMA.required).toEqual(names)
    expect(Object.keys(OPENUI_SCHEMA.properties ?? {})).toEqual(names)
    for (const name of names) expect(OPENUI_SCHEMA.$defs?.[name]).toBeDefined()
  })

  test("the prompt carries every component signature and description verbatim", () => {
    for (const name of names) {
      const spec = OPENUI_COMPONENTS[name]!
      expect(OPENUI_SYSTEM_PROMPT).toContain(spec.signature)
      if (spec.description) expect(OPENUI_SYSTEM_PROMPT).toContain(spec.description)
    }
    // Inline mode is what keeps a plain question a plain answer.
    expect(OPENUI_SYSTEM_PROMPT).toContain("```openui-lang")
  })

  test("the prompt is chat-first, so a plain question stays a plain answer", () => {
    // The upstream generator opens by telling the model its ENTIRE response must
    // be openui-lang, and inline mode does not soften that: the persona won, every
    // answer came back as a card, and a reply about not using cards came back as a
    // card. The provider prompt is replaced rather than merely followed by
    // restraint rules, which is what this guards.
    expect(OPENUI_SYSTEM_PROMPT).not.toContain("Your ENTIRE response must be valid openui-lang")
    expect(OPENUI_SYSTEM_PROMPT).toContain("you answer in plain markdown by default")
    expect(OPENUI_SYSTEM_PROMPT).toContain("Most replies need no drawing at all")
    expect(OPENUI_SYSTEM_PROMPT).toContain("A drawing is never the whole reply")
  })

  test("a report program parses into the components the client renders", () => {
    const result = parse(
      [
        "root = Stack([header, chart, table, note])",
        'header = CardHeader("Weekly report", "Last 7 days")',
        "chart = BarChart(labels, [series])",
        'labels = ["Mon", "Tue", "Wed"]',
        'series = Series("Signups", [12, 18, 9])',
        "table = Table([region, revenue])",
        'region = Col("Region", ["EMEA", "APAC"])',
        'revenue = Col("Revenue", [120, 98], "number")',
        'note = Callout("info", "On track", "Revenue is up 8% week over week.")',
      ].join("\n"),
    )
    expect(result.meta.errors).toEqual([])
    expect(result.meta.orphaned).toEqual([])
    expect(result.root?.typeName).toBe("Stack")
    const children = (result.root?.props.children ?? []) as unknown[]
    expect(children.flatMap((child) => (isOpenUIElement(child) ? [child.typeName] : []))).toEqual([
      "CardHeader",
      "BarChart",
      "Table",
      "Callout",
    ])
  })

  test("a form program parses, including its nested field controls", () => {
    const result = parse(
      [
        'root = Card([form])',
        'form = Form("signup", action, [email, plan])',
        'action = Buttons([submit])',
        'submit = Button("Sign up", @ToAssistant("signed up"), "primary")',
        'email = FormControl("Email", Input("email", "you@example.com", "email"), "We never share it.")',
        'plan = FormControl("Plan", Select("plan", [free, pro]))',
        'free = SelectItem("free", "Free")',
        'pro = SelectItem("pro", "Pro")',
      ].join("\n"),
    )
    expect(result.meta.errors).toEqual([])
    expect(result.root?.typeName).toBe("Card")
  })

  test("chart series and document shapes parse without validation errors", () => {
    const program = [
      "root = Stack([a, b, c, d, e])",
      'a = LineChart(["Q1", "Q2"], [s1], "natural")',
      's1 = Series("ARR", [1, 2])',
      "b = PieChart([\"US\", \"EU\"], [60, 40], \"donut\")",
      'c = HorizontalBarChart(["X"], [s1], "stacked")',
      'd = SingleStackedBarChart(["A", "B"], [30, 70])',
      'e = MetricIndicatorInline("128", "vs last week", { direction: "up", value: 12 })',
    ].join("\n")
    const result = parse(program)
    expect(result.meta.errors).toEqual([])
    expect(result.meta.statementCount).toBe(7)
  })

  test("a component the library does not have is reported, not rendered", () => {
    const result = parse('root = Stack([nope])\nnope = Imaginary("x")')
    expect(result.meta.errors.map((error) => error.component)).toContain("Imaginary")
    expect(result.root?.props.children ?? []).toEqual([])
  })

  test("this build's own components parse only with the extension merged in", () => {
    const program = 'root = Stack([doc])\ndoc = Html("Orbit", "<!doctype html><html></html>")'
    expect(parse(program).meta.errors.map((error) => error.component)).toContain("Html")

    const merged = mergeOpenUISchema(OPENUI_SCHEMA)
    for (const name of OPENUI_EXTENSION_COMPONENTS) {
      expect(merged.properties?.[name]).toBeDefined()
      expect(merged.$defs?.[name]).toBeDefined()
      // The same contract the generated library keeps: whatever the schema
      // declares is what the prompt advertises, signature and all.
      expect(OPENUI_EXTENSION_PROMPT).toContain(OPENUI_EXTENSION_SIGNATURES[name])
      expect(OPENUI_EXTENSION_PROMPT).toContain(String(merged.$defs?.[name]?.description))
    }

    const extended = merged as unknown as ParserSchema
    const result = createParser(extended, "Stack").parse(program)
    expect(result.meta.errors).toEqual([])
    const children = (result.root?.props.children ?? []) as unknown[]
    expect(children.flatMap((child) => (isOpenUIElement(child) ? [child.typeName] : []))).toEqual(["Html"])
  })

  test("generated component lists accept the extension components", () => {
    const merged = mergeOpenUISchema(OPENUI_SCHEMA) as unknown as ParserSchema
    const result = createParser(merged, "Stack").parse(
      [
        "root = Card([drawing])",
        'drawing = Svg("<svg viewBox=\'0 0 10 10\'><circle cx=\'5\' cy=\'5\' r=\'4\'/></svg>", "Orbit")',
      ].join("\n"),
    )
    expect(result.meta.errors).toEqual([])
    const children = (result.root?.props.children ?? []) as unknown[]
    expect(children.flatMap((child) => (isOpenUIElement(child) ? [child.typeName] : []))).toEqual(["Svg"])
  })

  test("a JS card carries its program through escaping, size and all", () => {
    const merged = mergeOpenUISchema(OPENUI_SCHEMA) as unknown as ParserSchema
    // A JS card is JavaScript inside a string inside a program, so the escaping
    // rule is the whole contract: what the model writes is exactly what runs.
    const result = createParser(merged, "Stack").parse(
      [
        "root = Stack([card])",
        'card = JsCard("root.replaceChildren()\\nconst box = canvas().fit()\\nconst at = \\"noon\\"", "Orbit", 320, 60)',
      ].join("\n"),
    )

    expect(result.meta.errors).toEqual([])
    const children = (result.root?.props.children ?? []) as unknown[]
    expect(children.flatMap((child) => (isOpenUIElement(child) ? [child.typeName] : []))).toEqual(["JsCard"])

    const card = children[0]
    if (!isOpenUIElement(card)) throw new Error("JsCard did not parse into an element")
    expect(card.props.code).toBe('root.replaceChildren()\nconst box = canvas().fit()\nconst at = "noon"')
    expect(card.props.title).toBe("Orbit")
    expect(card.props.height).toBe(320)
    expect(card.props.width).toBe(60)
  })

  test("streaming reveals the shell first and fills children in as they arrive", () => {
    const parser = createStreamingParser(parserSchema, "Stack")
    const first = parser.push("root = Stack([header, chart])\n")
    expect(first.root?.typeName).toBe("Stack")
    expect(first.meta.unresolved).toEqual(["header", "chart"])
    expect(first.root?.props.children).toEqual([])

    const second = parser.push('header = CardHeader("Weekly report")\n')
    const children = (second.root?.props.children ?? []) as unknown[]
    expect(children.flatMap((child) => (isOpenUIElement(child) ? [child.typeName] : []))).toEqual(["CardHeader"])
    expect(second.meta.unresolved).toEqual(["chart"])

    const settled = parser.push("chart = BarChart([], [])\n")
    const final = (settled.root?.props.children ?? []) as unknown[]
    expect(final.flatMap((child) => (isOpenUIElement(child) ? [child.typeName] : []))).toEqual(["CardHeader", "BarChart"])
    expect(settled.meta.unresolved).toEqual([])
  })
})
