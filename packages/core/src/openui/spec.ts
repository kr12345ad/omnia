// GENERATED FILE — do not edit by hand.
// Source: thesysdev/openui @openuidev/react-ui openuiLibrary, pruned to the
// components the Solid renderer implements (see packages/core/src/openui/AGENTS.md).
// Regenerate with: bun run script/extract-openui-library.ts

export const OPENUI_ROOT = "Stack"

export type OpenUIComponentSpec = { signature: string; description?: string }

export type OpenUIComponentGroup = { name: string; components: string[]; notes?: string[] }

export const OPENUI_COMPONENTS: Readonly<Record<string, OpenUIComponentSpec>> = {
  "Stack": {
    "signature": "Stack(children: any[], direction?: \"row\" | \"column\", gap?: \"none\" | \"xs\" | \"s\" | \"m\" | \"l\" | \"xl\" | \"2xl\", align?: \"start\" | \"center\" | \"end\" | \"stretch\" | \"baseline\", justify?: \"start\" | \"center\" | \"end\" | \"between\" | \"around\" | \"evenly\", wrap?: boolean)",
    "description": "Flex container. direction: \"row\"|\"column\" (default \"column\"). gap: \"none\"|\"xs\"|\"s\"|\"m\"|\"l\"|\"xl\"|\"2xl\" (default \"m\"). align: \"start\"|\"center\"|\"end\"|\"stretch\"|\"baseline\". justify: \"start\"|\"center\"|\"end\"|\"between\"|\"around\"|\"evenly\"."
  },
  "Separator": {
    "signature": "Separator(orientation?: \"horizontal\" | \"vertical\", decorative?: boolean)",
    "description": "Visual divider between content sections"
  },
  "Tabs": {
    "signature": "Tabs(items: TabItem[])",
    "description": "Tabbed container"
  },
  "TabItem": {
    "signature": "TabItem(value: string, trigger: string, content: (TextContent | MarkDownRenderer | CardHeader | Callout | TextCallout | CodeBlock | Image | ImageBlock | ImageGallery | Separator | HorizontalBarChart | RadarChart | PieChart | RadialChart | SingleStackedBarChart | ScatterChart | AreaChart | BarChart | LineChart | Table | TagBlock | Form | Buttons | IconButton | Steps | InlineHeader | EntityList | EditableTable | SnippetCardBlock | OverviewCardBlock | ContextCardBlock | CompositeCardBlock | VisualCardBlock)[])",
    "description": "value is unique id, trigger is tab label, content is array of components"
  },
  "Steps": {
    "signature": "Steps(items: StepsItem[])",
    "description": "Step-by-step guide"
  },
  "StepsItem": {
    "signature": "StepsItem(title: string, details: string)",
    "description": "title and details text for one step"
  },
  "Modal": {
    "signature": "Modal(title: string, open?: $binding<boolean>, children: (TextContent | MarkDownRenderer | CardHeader | Callout | TextCallout | CodeBlock | Image | ImageBlock | ImageGallery | Separator | HorizontalBarChart | RadarChart | PieChart | RadialChart | SingleStackedBarChart | ScatterChart | AreaChart | BarChart | LineChart | Table | TagBlock | Form | Buttons | IconButton | Steps | InlineHeader | EntityList | EditableTable | SnippetCardBlock | OverviewCardBlock | ContextCardBlock | CompositeCardBlock | VisualCardBlock)[], size?: \"sm\" | \"md\" | \"lg\")",
    "description": "Modal dialog. open is a reactive $boolean binding — set to true to open, X/Escape/backdrop auto-closes. Put Form with buttons inside children."
  },
  "Card": {
    "signature": "Card(children: (TextContent | MarkDownRenderer | CardHeader | Callout | TextCallout | CodeBlock | Image | ImageBlock | ImageGallery | Separator | HorizontalBarChart | RadarChart | PieChart | RadialChart | SingleStackedBarChart | ScatterChart | AreaChart | BarChart | LineChart | Table | TagBlock | Form | Buttons | IconButton | Steps | InlineHeader | EntityList | EditableTable | SnippetCardBlock | OverviewCardBlock | ContextCardBlock | CompositeCardBlock | VisualCardBlock | Tabs | Carousel | Stack)[], variant?: \"card\" | \"sunk\" | \"clear\", direction?: \"row\" | \"column\", gap?: \"none\" | \"xs\" | \"s\" | \"m\" | \"l\" | \"xl\" | \"2xl\", align?: \"start\" | \"center\" | \"end\" | \"stretch\" | \"baseline\", justify?: \"start\" | \"center\" | \"end\" | \"between\" | \"around\" | \"evenly\", wrap?: boolean)",
    "description": "Styled container. variant: \"card\" (default, elevated) | \"sunk\" (recessed) | \"clear\" (transparent). Always full width. Accepts all Stack flex params (default: direction \"column\"). Cards flex to share space in row/wrap layouts."
  },
  "CardHeader": {
    "signature": "CardHeader(title?: string, subtitle?: string)",
    "description": "Header with optional title and subtitle"
  },
  "TextContent": {
    "signature": "TextContent(text: string, size?: \"small\" | \"default\" | \"large\" | \"small-heavy\" | \"large-heavy\")",
    "description": "Text block. Supports markdown. Optional size: \"small\" | \"default\" | \"large\" | \"small-heavy\" | \"large-heavy\"."
  },
  "MarkDownRenderer": {
    "signature": "MarkDownRenderer(textMarkdown: string, variant?: \"clear\" | \"card\" | \"sunk\")",
    "description": "Renders markdown text with optional container variant"
  },
  "Callout": {
    "signature": "Callout(variant: \"info\" | \"warning\" | \"error\" | \"success\" | \"neutral\", title: string, description: string, visible?: $binding<boolean>)",
    "description": "Callout banner. Optional visible is a reactive $boolean — auto-dismisses after 3s by setting $visible to false."
  },
  "TextCallout": {
    "signature": "TextCallout(variant?: \"neutral\" | \"info\" | \"warning\" | \"success\" | \"danger\", title?: string, description?: string)",
    "description": "Text callout with variant, title, and description"
  },
  "Image": {
    "signature": "Image(alt: string, src?: string)",
    "description": "Image with alt text and optional URL"
  },
  "ImageBlock": {
    "signature": "ImageBlock(src: string, alt?: string)",
    "description": "Image block with loading state"
  },
  "CodeBlock": {
    "signature": "CodeBlock(language: string, codeString: string)",
    "description": "Syntax-highlighted code block"
  },
  "InlineHeader": {
    "signature": "InlineHeader(heading: string, description?: string)",
    "description": "Compact section heading with an optional one-line description, for use inside cards."
  },
  "ListBlock": {
    "signature": "ListBlock(items: ListItem[], variant?: \"number\" | \"image\", size?: \"default\" | \"small\")",
    "description": "A list of items with number or image indicators. Each item can optionally have an action. size small renders a compact list."
  },
  "ListItem": {
    "signature": "ListItem(title: string, subtitle?: string, image?: {src: string, alt: string}, actionLabel?: string, action?: ActionExpression)",
    "description": "Item in a ListBlock — displays a title with an optional subtitle and image. When action is provided, the item becomes clickable."
  },
  "TagBlock": {
    "signature": "TagBlock(tags: string[], size?: \"sm\" | \"md\" | \"lg\")",
    "description": "tags is an array of strings; optional size sm | md | lg"
  },
  "Tag": {
    "signature": "Tag(text: string, icon?: Icon, size?: \"sm\" | \"md\" | \"lg\", variant?: \"neutral\" | \"info\" | \"success\" | \"warning\" | \"danger\")",
    "description": "Styled tag/badge with optional Icon and variant"
  },
  "Icon": {
    "signature": "Icon(name: string, category?: string)",
    "description": "A lucide icon by kebab-case name (e.g. 'circle-check'). Optional category picks a topical fallback when the name doesn't resolve."
  },
  "EntityList": {
    "signature": "EntityList(rows?: {left: string, right: string, rightVariant?: \"text\" | \"number\"}[], size?: \"small\" | \"default\", header?: {left: string, right: string, rightVariant?: \"text\" | \"number\"}, footer?: {left: string, right: string, rightVariant?: \"text\" | \"number\"})",
    "description": "Two-column key/value rows (left label, right value). size 'default' supports optional header and footer rows; rightVariant 'number' uses tabular numbers."
  },
  "Text": {
    "signature": "Text(variant?: \"text\" | \"number\", value: string, subtext?: string, subtextVariant?: \"text\" | \"number\" | \"metric\", size?: \"xs\" | \"sm\" | \"md\" | \"lg\")",
    "description": "Plain text line with optional subtext. variant 'number' uses tabular number styling; subtextVariant 'metric' colors a leading +/- subtext green/red."
  },
  "BoldText": {
    "signature": "BoldText(variant?: \"text\" | \"number\", value: string, subtext?: string, subtextVariant?: \"text\" | \"number\" | \"metric\", size?: \"xs\" | \"sm\" | \"md\" | \"lg\")",
    "description": "Emphasized (bold) text line with optional subtext. variant 'number' uses tabular number styling; subtextVariant 'metric' colors a leading +/- subtext green/red."
  },
  "IconText": {
    "signature": "IconText(icon: Icon, iconVariant?: \"neutral\" | \"info\" | \"success\" | \"warning\" | \"danger\" | \"inverted\" | \"filled\" | \"soft\", iconSize?: \"xs\" | \"s\" | \"m\" | \"l\" | \"xl\" | \"sm\" | \"md\" | \"lg\", title: string, subtitle?: string, bold?: boolean, layout?: \"horizontal\" | \"vertical\")",
    "description": "An icon badge with a title and optional subtitle, laid out horizontally or vertically. iconVariant sets the badge color."
  },
  "MetricIndicatorInline": {
    "signature": "MetricIndicatorInline(value: string, subtext?: string, trend?: {direction: \"up\" | \"down\", value: number})",
    "description": "Headline metric value with an optional +/- percentage trend and subtext, all on one line."
  },
  "Table": {
    "signature": "Table(columns: Col[])",
    "description": "Data table — column-oriented. Each Col holds its own data array."
  },
  "Col": {
    "signature": "Col(label: string, data: any, type?: \"string\" | \"number\" | \"action\")",
    "description": "Column definition — holds label + data array"
  },
  "BarChart": {
    "signature": "BarChart(labels: string[], series: Series[], variant?: \"grouped\" | \"stacked\", xLabel?: string, yLabel?: string, height?: number)",
    "description": "Vertical bars; use for comparing values across categories with one or more series"
  },
  "LineChart": {
    "signature": "LineChart(labels: string[], series: Series[], variant?: \"linear\" | \"natural\" | \"step\", xLabel?: string, yLabel?: string, height?: number)",
    "description": "Lines over categories; use for trends and continuous data over time"
  },
  "AreaChart": {
    "signature": "AreaChart(labels: string[], series: Series[], variant?: \"linear\" | \"natural\" | \"step\", xLabel?: string, yLabel?: string, height?: number)",
    "description": "Filled area under lines; use for cumulative totals or volume trends over time"
  },
  "PieChart": {
    "signature": "PieChart(labels: string[], values: number[], variant?: \"pie\" | \"donut\", appearance?: \"circular\" | \"semiCircular\")",
    "description": "Circular slices; use plucked arrays: PieChart(data.categories, data.values)"
  },
  "HorizontalBarChart": {
    "signature": "HorizontalBarChart(labels: string[], series: Series[], variant?: \"grouped\" | \"stacked\", xLabel?: string, yLabel?: string)",
    "description": "Horizontal bars; prefer when category labels are long or for ranked lists"
  },
  "SingleStackedBarChart": {
    "signature": "SingleStackedBarChart(labels: string[], values: number[])",
    "description": "Single horizontal stacked bar; use plucked arrays: SingleStackedBarChart(data.categories, data.values)"
  },
  "Series": {
    "signature": "Series(category: string, values: number[])",
    "description": "One data series"
  },
  "Form": {
    "signature": "Form(name: string, buttons: Buttons, fields?: FormControl[])",
    "description": "Form container with fields and explicit action buttons"
  },
  "FormControl": {
    "signature": "FormControl(label: string, input: Input | TextArea | Select | DatePicker | Slider | CheckBoxGroup | RadioGroup | Chips | OptionCards, hint?: string)",
    "description": "Field with label, input component, and optional hint text"
  },
  "Label": {
    "signature": "Label(text: string)",
    "description": "Text label"
  },
  "Input": {
    "signature": "Input(name: string, placeholder?: string, type?: \"text\" | \"email\" | \"password\" | \"number\" | \"url\", rules?: {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}, value?: $binding<string>)",
    "description": ""
  },
  "TextArea": {
    "signature": "TextArea(name: string, placeholder?: string, rows?: number, rules?: {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}, value?: $binding<string>)",
    "description": ""
  },
  "Select": {
    "signature": "Select(name: string, items: SelectItem[], placeholder?: string, rules?: {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}, value?: $binding<string>, size?: \"small\" | \"medium\" | \"large\")",
    "description": ""
  },
  "SelectItem": {
    "signature": "SelectItem(value: string, label: string)",
    "description": "Option for Select"
  },
  "CheckBoxGroup": {
    "signature": "CheckBoxGroup(name: string, items: CheckBoxItem[], rules?: {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}, value?: $binding<Record<string, boolean>>)",
    "description": ""
  },
  "CheckBoxItem": {
    "signature": "CheckBoxItem(label: string, description: string, name: string, defaultChecked?: boolean)",
    "description": ""
  },
  "RadioGroup": {
    "signature": "RadioGroup(name: string, items: RadioItem[], defaultValue?: string, rules?: {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}, value?: $binding<string>)",
    "description": ""
  },
  "RadioItem": {
    "signature": "RadioItem(label: string, description: string, value: string)",
    "description": ""
  },
  "SwitchGroup": {
    "signature": "SwitchGroup(name: string, items: SwitchItem[], variant?: \"clear\" | \"card\" | \"sunk\", value?: $binding<Record<string, boolean>>)",
    "description": "Group of switch toggles"
  },
  "SwitchItem": {
    "signature": "SwitchItem(label?: string, description?: string, name: string, defaultChecked?: boolean)",
    "description": "Individual switch toggle"
  },
  "Slider": {
    "signature": "Slider(name: string, variant: \"continuous\" | \"discrete\", min: number, max: number, step?: number, defaultValue?: number[], label?: string, rules?: {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}, value?: $binding<number[]>)",
    "description": "Numeric slider input; supports continuous and discrete (stepped) variants"
  },
  "Chips": {
    "signature": "Chips(name: string, type?: \"single\" | \"multiple\", items?: ChipItem[], rules?: {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}, defaultValue?: string | string[])",
    "description": "A form field of compact selectable chips for choosing one or many short options; the selection is stored under `name`."
  },
  "ChipItem": {
    "signature": "ChipItem(value: string, label: string, icon?: Icon, disabled?: boolean)",
    "description": "A single selectable chip inside a Chips group, with a value, label and optional icon."
  },
  "OptionCards": {
    "signature": "OptionCards(name: string, type?: \"single\" | \"multiple\", items?: OptionCard[], rules?: {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}, defaultValue?: string | string[])",
    "description": "A form field of selectable cards (title, optional subtitle, optional icon or image) laid out in a responsive grid for choosing one or many options; the selection is stored under `name`."
  },
  "OptionCard": {
    "signature": "OptionCard(value: string, title: string, subtitle?: string, topContent?: Icon | Image, disabled?: boolean)",
    "description": "A single selectable card inside an OptionCards group, with a value, title, optional subtitle and an optional Icon or Image on top."
  },
  "Buttons": {
    "signature": "Buttons(buttons: Button[], direction?: \"row\" | \"column\")",
    "description": "Group of Button components. direction: \"row\" (default) | \"column\"."
  },
  "Button": {
    "signature": "Button(label: string, action?: ActionExpression, variant?: \"primary\" | \"secondary\" | \"tertiary\", type?: \"normal\" | \"destructive\", size?: \"extra-small\" | \"small\" | \"medium\" | \"large\")",
    "description": "Clickable button"
  },
  "IconButton": {
    "signature": "IconButton(name: string, icon: Icon, action?: ActionExpression, variant?: \"primary\" | \"secondary\" | \"tertiary\", size?: \"extra-small\" | \"small\" | \"medium\" | \"large\", shape?: \"square\" | \"circle\")",
    "description": "Icon-only button. name is the accessible label and the action label; icon is an Icon; action fires on click."
  }
}

export const OPENUI_COMPONENT_GROUPS: readonly OpenUIComponentGroup[] = [
  {
    "name": "Layout",
    "components": [
      "Stack",
      "Tabs",
      "TabItem",
      "Steps",
      "StepsItem",
      "Separator",
      "Modal"
    ],
    "notes": [
      "- For grid-like layouts, use Stack with direction \"row\" and wrap set to true.",
      "- Prefer justify \"start\" (or omit justify) with wrap=true for stable columns instead of uneven gutters.",
      "- Use nested Stacks when you need explicit rows/sections.",
      "- Show/hide sections: $editId != \"\" ? Card([editForm]) : null",
      "- Modal: Modal(\"Title\", $showModal, [content]) — $showModal is boolean, X/Escape auto-closes. Put Form with its own buttons inside children.",
      "- Use Tabs for alternative views (chart types, data sections) — no $variable needed",
      "- Shared filter across Tabs: same $days binding in Query args works across all TabItems"
    ]
  },
  {
    "name": "Content",
    "components": [
      "Card",
      "CardHeader",
      "TextContent",
      "MarkDownRenderer",
      "Callout",
      "TextCallout",
      "Image",
      "ImageBlock",
      "CodeBlock",
      "InlineHeader"
    ],
    "notes": [
      "- InlineHeader is a compact heading + description pair for labelling a block (lighter than CardHeader).",
      "- Use Cards to group related KPIs or sections. Stack with direction \"row\" for side-by-side layouts.",
      "- Success toast: Callout(\"success\", \"Saved\", \"Done.\", $showSuccess) — use @Set($showSuccess, true) in save action, auto-dismisses after 3s. For errors: result.status == \"error\" ? Callout(\"error\", \"Failed\", result.error) : null",
      "- KPI card: Card([TextContent(\"Label\", \"small\"), TextContent(\"\" + @Count(@Filter(data.rows, \"field\", \"==\", \"value\")), \"large-heavy\")])"
    ]
  },
  {
    "name": "Tables",
    "components": [
      "Table",
      "Col"
    ],
    "notes": [
      "- EditableTable lets the user edit cells inline. Give it a unique name, columns of { type, key, header } with type one of text | number | date-single | select | url (select also needs options: [{ value, label }]).",
      "- data is an array of { id, values } rows where values are ordered positionally to match columns. Edited data is submitted when the user clicks Save Changes.",
      "- Table is COLUMN-oriented: Table([Col(\"Label\", dataArray), Col(\"Count\", countArray, \"number\")]). Use array pluck for data: data.rows.fieldName",
      "- Col data can be component arrays for styled cells: Col(\"Status\", @Each(data.rows, \"item\", Tag(item.status, null, \"sm\", item.status == \"open\" ? \"success\" : \"danger\")))",
      "- Row actions: Col(\"Actions\", @Each(data.rows, \"t\", Button(\"Edit\", Action([@Set($showEdit, true), @Set($editId, t.id)]))))",
      "- Sortable: sorted = @Sort(data.rows, $sortField, \"desc\"). Bind $sortField to Select. Use sorted.fieldName for Col data",
      "- Searchable: filtered = @Filter(data.rows, \"title\", \"contains\", $search). Bind $search to Input",
      "- Chain sort + filter: filtered = @Filter(...) then sorted = @Sort(filtered, ...) — use sorted for both Table and Charts",
      "- Empty state: @Count(data.rows) > 0 ? Table([...]) : TextContent(\"No data yet\")"
    ]
  },
  {
    "name": "Charts (2D)",
    "components": [
      "BarChart",
      "LineChart",
      "AreaChart",
      "HorizontalBarChart",
      "Series"
    ],
    "notes": [
      "- Charts accept column arrays: LineChart(labels, [Series(\"Name\", values)]). Use array pluck: LineChart(data.rows.day, [Series(\"Views\", data.rows.views)])",
      "- Use Cards to wrap charts with CardHeader for titled sections",
      "- Chart + Table from same source: use @Sort or @Filter result for both LineChart and Table Col data",
      "- Multiple chart views: use Tabs — Tabs([TabItem(\"line\", \"Line\", [LineChart(...)]), TabItem(\"bar\", \"Bar\", [BarChart(...)])])"
    ]
  },
  {
    "name": "Charts (1D)",
    "components": [
      "PieChart",
      "SingleStackedBarChart"
    ],
    "notes": [
      "- PieChart and BarChart need NUMBERS, not objects. For list data, use @Count(@Filter(...)) to aggregate:",
      "- PieChart from list: `PieChart([\"Low\", \"Med\", \"High\"], [@Count(@Filter(data.rows, \"priority\", \"==\", \"low\")), @Count(@Filter(data.rows, \"priority\", \"==\", \"medium\")), @Count(@Filter(data.rows, \"priority\", \"==\", \"high\"))], \"donut\")`",
      "- KPI from count: `TextContent(\"\" + @Count(@Filter(data.rows, \"status\", \"==\", \"open\")), \"large-heavy\")`"
    ]
  },
  {
    "name": "Forms",
    "components": [
      "Form",
      "FormControl",
      "Label",
      "Input",
      "TextArea",
      "Select",
      "SelectItem",
      "Slider",
      "CheckBoxGroup",
      "CheckBoxItem",
      "RadioGroup",
      "RadioItem",
      "SwitchGroup",
      "SwitchItem",
      "Chips",
      "ChipItem",
      "OptionCards",
      "OptionCard"
    ],
    "notes": [
      "- Chips: compact single/multiple selection pills. Use ChipItem references for each option.",
      "- OptionCards: larger selectable cards with title, subtitle and an optional Icon or Image on top. Use OptionCard references for each option.",
      "- For Form fields, define EACH FormControl as its own reference — do NOT inline all controls in one array. This allows progressive field-by-field streaming.",
      "- NEVER nest Form inside Form — each Form should be a standalone container.",
      "- Form requires explicit buttons. Always pass a Buttons(...) reference as the third Form argument.",
      "- rules is an optional object: {required: true, email: true, minLength: 8, maxLength: 100}",
      "- Available rules: required, email, min, max, minLength, maxLength, pattern, url, numeric",
      "- The renderer shows error messages automatically — do NOT generate error text in the UI",
      "- Conditional fields: $country == \"US\" ? stateField : $country == \"UK\" ? postcodeField : addressField",
      "- Edit form in Modal: Modal(\"Edit\", $showEdit, [Form(\"edit\", Buttons([saveBtn, cancelBtn]), [fields...])]). Save button should include @Set($showEdit, false) to close modal."
    ]
  },
  {
    "name": "Buttons",
    "components": [
      "Button",
      "Buttons",
      "IconButton"
    ],
    "notes": [
      "- Icon renders a lucide icon by kebab-case name; it is also used as the icon of IconButton, IconText and OptionCard.",
      "- Toggle in @Each: @Each(rows, \"t\", Button(t.status == \"open\" ? \"Close\" : \"Reopen\", Action([...])))"
    ]
  },
  {
    "name": "Data Display",
    "components": [
      "TagBlock",
      "Tag",
      "Icon",
      "EntityList",
      "ListBlock",
      "ListItem"
    ],
    "notes": [
      "- Color-mapped Tag: Tag(value, null, \"sm\", value == \"high\" ? \"danger\" : value == \"medium\" ? \"warning\" : \"neutral\")",
      "- EntityList is a compact two-column list of { left, right } rows (e.g. name / value). size='default' also supports a header and footer row; size='small' does not.",
      "- ListBlock is a numbered or image list of ListItem references. An action on ListItem is optional."
    ]
  },
  {
    "name": "Cards",
    "components": [
      "Text",
      "BoldText",
      "IconText",
      "MetricIndicatorInline"
    ],
    "notes": [
      "- Card blocks lay out 2+ items in a responsive grid (or carousel where supported). Every item in a block must have the same structure.",
      "- SnippetCardItem: small card with lhs (IconText | ImageText) and optional rhs (Text | BoldText) — good for key/value facts.",
      "- OverviewCardItem: small card with top (IconText | ImageText | Text) and optional bottom MetricIndicatorInline — good for KPIs.",
      "- ContextCardItem: medium card with a title (string or Tag), body text and optional background image — good for summaries.",
      "- CompositeCardItem: rich card with header, body array (Text, BoldText, MetricIndicatorInline, IconText, Image, charts, ListBlock, TagBlock, EntityList) and footer (price + Button) — good for products/offers.",
      "- VisualCardItem: image-first card with a BoldText body and optional Tag.",
      "- Text / BoldText / IconText / ImageText / ImageTextLarge / MetricIndicator* are the inline building blocks used INSIDE card items; do not place them directly in the root Card."
    ]
  }
]
