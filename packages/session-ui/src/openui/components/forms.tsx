import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { RadioGroupV2, RadioItemV2 } from "@opencode-ai/ui/v2/radio-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import {
  createContext,
  createSignal,
  createUniqueId,
  For,
  Show,
  useContext,
  type JSX,
} from "solid-js"
import { bool, decl, decls, num, numbers, text } from "../helpers"
import { DISABLED, FOCUS, HOVER, PANEL, PILL, TEXT, TEXT_MUTED } from "../theme"
import type { OpenUIComponentRenderer, OpenUIRendererMap } from "../types"

/**
 * Form components.
 *
 * A generated form is inert: there is no server round-trip, so "submitting" only
 * ever means the user pressing a generated button, which the caller turns into
 * the next chat turn. Field state is local to each renderer, seeded from the
 * `value` / `defaultValue` / `defaultChecked` the model supplied.
 *
 * `FormControl` owns the visible label and hint and publishes their ids through
 * context, so a field attaches them to whichever control actually takes focus
 * (`aria-labelledby` / `aria-describedby`). A field used outside a FormControl
 * falls back to the field `name` as its accessible name.
 */
type FormFieldIds = { labelId?: string; hintId?: string }

const FormFieldContext = createContext<FormFieldIds>({})

function useFormField() {
  return useContext(FormFieldContext)
}

type RenderInput = Parameters<OpenUIComponentRenderer>[0]

const INPUT_TYPES = new Set(["text", "email", "password", "number", "url"])

function inputType(value: unknown) {
  const type = text(value)
  return type !== undefined && INPUT_TYPES.has(type) ? (type as JSX.InputHTMLAttributes<HTMLInputElement>["type"]) : "text"
}

function requiredRule(value: unknown) {
  return bool(decl(value)?.required)
}

function FormContainer(input: RenderInput): JSX.Element {
  return (
    <form
      data-component="openui-form"
      data-openui-form={text(input.props.name)}
      class="flex flex-col gap-4"
      onSubmit={(event) => event.preventDefault()}
    >
      <div data-slot="openui-form-fields" class="flex flex-col gap-3">
        {input.renderNode(input.props.fields)}
      </div>
      {input.renderNode(input.props.buttons)}
    </form>
  )
}

function FormControlField(input: RenderInput): JSX.Element {
  const label = text(input.props.label)
  const hint = text(input.props.hint)
  const labelId = `openui-field-label-${createUniqueId()}`
  const hintId = `openui-field-hint-${createUniqueId()}`

  return (
    <FormFieldContext.Provider value={{ labelId: label ? labelId : undefined, hintId: hint ? hintId : undefined }}>
      <div data-component="openui-form-control" class="flex flex-col gap-2">
        <Show when={label}>
          {(value) => (
            <span id={labelId} data-slot="openui-form-control-label" class={`text-13-medium ${TEXT}`}>
              {value()}
            </span>
          )}
        </Show>
        {input.renderNode(input.props.input)}
        <Show when={hint}>
          {(value) => (
            <span id={hintId} data-slot="openui-form-control-hint" class={`text-12-regular ${TEXT_MUTED}`}>
              {value()}
            </span>
          )}
        </Show>
      </div>
    </FormFieldContext.Provider>
  )
}

function LabelText(input: RenderInput): JSX.Element {
  return (
    <span data-component="openui-label" class={`text-13-medium ${TEXT}`}>
      {text(input.props.text) ?? ""}
    </span>
  )
}

function InputField(input: RenderInput): JSX.Element {
  const field = useFormField()
  const name = text(input.props.name)
  // Solid has no uncontrolled `defaultValue`: the model's seed value lives in a
  // signal and the field stays controlled from there.
  const [value, setValue] = createSignal(text(input.props.value) ?? "")
  return (
    <div data-component="openui-input">
      <TextInputV2
        appearance="large"
        name={name}
        type={inputType(input.props.type)}
        placeholder={text(input.props.placeholder)}
        value={value()}
        onInput={(event) => setValue(event.currentTarget.value)}
        required={requiredRule(input.props.rules)}
        aria-label={field.labelId ? undefined : name}
        aria-labelledby={field.labelId}
        aria-describedby={field.hintId}
      />
    </div>
  )
}

function TextAreaField(input: RenderInput): JSX.Element {
  const field = useFormField()
  const name = text(input.props.name)
  const [value, setValue] = createSignal(text(input.props.value) ?? "")
  return (
    <div data-component="openui-textarea">
      <TextareaV2
        name={name}
        placeholder={text(input.props.placeholder)}
        rows={num(input.props.rows)}
        value={value()}
        onInput={(event) => setValue(event.currentTarget.value)}
        required={requiredRule(input.props.rules)}
        aria-label={field.labelId ? undefined : name}
        aria-labelledby={field.labelId}
        aria-describedby={field.hintId}
      />
    </div>
  )
}

const SELECT_SIZE: Record<string, string> = {
  small: "h-6 text-12-regular",
  medium: "h-7 text-13-regular",
  large: "h-8 text-13-regular",
}

function SelectField(input: RenderInput): JSX.Element {
  const field = useFormField()
  const name = text(input.props.name)
  const items = () => decls(input.props.items)
  const placeholder = text(input.props.placeholder)
  const size = text(input.props.size)
  const [value, setValue] = createSignal(text(input.props.value) ?? "")

  return (
    <div data-component="openui-select" class="relative w-full">
      <select
        name={name}
        value={value()}
        onChange={(event) => setValue(event.currentTarget.value)}
        required={requiredRule(input.props.rules)}
        aria-label={field.labelId ? undefined : name}
        aria-labelledby={field.labelId}
        aria-describedby={field.hintId}
        class={`w-full appearance-none rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 pl-3 pr-8 ${TEXT} ${FOCUS} ${DISABLED} ${
          SELECT_SIZE[size ?? "medium"] ?? SELECT_SIZE.medium
        }`}
      >
        <Show when={placeholder}>
          {(value) => <option value="">{value()}</option>}
        </Show>
        <For each={items()}>
          {(item) => <option value={text(item.value) ?? ""}>{text(item.label) ?? text(item.value) ?? ""}</option>}
        </For>
      </select>
      <svg
        aria-hidden="true"
        data-slot="openui-select-chevron"
        class="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-v2-icon-icon-muted"
        viewBox="0 0 16 16"
        fill="none"
      >
        <path d="M11 9.5L8 6.5 5 9.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>
  )
}

function CheckBoxGroupField(input: RenderInput): JSX.Element {
  const field = useFormField()
  const groupName = text(input.props.name)
  return (
    <div
      role="group"
      data-component="openui-checkbox-group"
      aria-labelledby={field.labelId}
      aria-describedby={field.hintId}
      aria-required={requiredRule(input.props.rules) ? true : undefined}
      class="flex flex-col gap-2"
    >
      <For each={decls(input.props.items)}>
        {(item) => (
          <CheckboxV2
            label={text(item.label) ?? ""}
            description={text(item.description) ?? ""}
            name={text(item.name) ?? groupName}
            defaultChecked={bool(item.defaultChecked)}
          />
        )}
      </For>
    </div>
  )
}

function RadioGroupField(input: RenderInput): JSX.Element {
  const field = useFormField()
  const groupName = text(input.props.name)
  return (
    <RadioGroupV2
      name={groupName}
      defaultValue={text(input.props.defaultValue)}
      aria-labelledby={field.labelId}
      aria-describedby={field.hintId}
      aria-required={requiredRule(input.props.rules) ? true : undefined}
      data-component="openui-radio-group"
    >
      <For each={decls(input.props.items)}>
        {(item) => (
          <RadioItemV2
            value={text(item.value) ?? ""}
            label={text(item.label) ?? ""}
            description={text(item.description) ?? ""}
          />
        )}
      </For>
    </RadioGroupV2>
  )
}

function SwitchGroupField(input: RenderInput): JSX.Element {
  const field = useFormField()
  const groupName = text(input.props.name)
  return (
    <div
      role="group"
      data-component="openui-switch-group"
      aria-labelledby={field.labelId}
      aria-describedby={field.hintId}
      class="flex flex-col gap-3"
    >
      <For each={decls(input.props.items)}>
        {(item) => {
          const label = text(item.label) ?? text(item.name) ?? ""
          const description = text(item.description)
          return (
            <div class="flex items-center justify-between gap-3">
              <div class="flex min-w-0 flex-col">
                <span data-slot="openui-switch-label" class={`text-13-regular ${TEXT}`}>
                  {label}
                </span>
                <Show when={description}>
                  {(value) => (
                    <span data-slot="openui-switch-description" class={`text-12-regular ${TEXT_MUTED}`}>
                      {value()}
                    </span>
                  )}
                </Show>
              </div>
              <Switch
                name={text(item.name) ?? groupName}
                defaultChecked={bool(item.defaultChecked)}
                hideLabel
                data-slot="openui-switch"
              >
                {label}
              </Switch>
            </div>
          )
        }}
      </For>
    </div>
  )
}

function SliderField(input: RenderInput): JSX.Element {
  const field = useFormField()
  const name = text(input.props.name)
  const min = num(input.props.min) ?? 0
  const max = num(input.props.max) ?? 100
  const discrete = text(input.props.variant) === "discrete"
  const step = discrete ? (num(input.props.step) ?? 1) : (num(input.props.step) ?? "any")
  const [value, setValue] = createSignal(numbers(input.props.defaultValue)[0] ?? min)
  const caption = field.labelId ? undefined : (text(input.props.label) ?? name)

  return (
    <div data-component="openui-slider" class="flex items-center gap-3">
      <input
        type="range"
        name={name}
        min={min}
        max={max}
        step={step}
        value={value()}
        aria-label={caption}
        aria-labelledby={field.labelId}
        aria-describedby={field.hintId}
        aria-required={requiredRule(input.props.rules) ? true : undefined}
        class={`h-1.5 w-full appearance-none rounded-full bg-v2-background-bg-layer-02 accent-[var(--v2-text-text-accent)] ${FOCUS} ${DISABLED}`}
        onInput={(event) => setValue(event.currentTarget.valueAsNumber)}
      />
      <span data-slot="openui-slider-value" class={`min-w-6 text-right text-12-regular tabular-nums ${TEXT_MUTED}`}>
        {value()}
      </span>
    </div>
  )
}

function initialChips(value: unknown, multiple: boolean) {
  if (Array.isArray(value)) return value.flatMap((item) => text(item) ?? [])
  const single = text(value)
  if (single === undefined) return []
  return multiple ? [single] : []
}

function ChipsField(input: RenderInput): JSX.Element {
  const field = useFormField()
  const multiple = text(input.props.type) === "multiple"
  const [selected, setSelected] = createSignal(initialChips(input.props.defaultValue, multiple))

  const toggle = (value: string) =>
    setSelected((current) => {
      if (current.includes(value)) return current.filter((item) => item !== value)
      return multiple ? [...current, value] : [value]
    })

  return (
    <div
      role="group"
      data-component="openui-chips"
      aria-labelledby={field.labelId}
      aria-describedby={field.hintId}
      aria-required={requiredRule(input.props.rules) ? true : undefined}
      class="flex flex-wrap gap-1.5"
    >
      <For each={decls(input.props.items)}>
        {(item) => {
          const value = text(item.value) ?? ""
          const label = text(item.label) ?? value
          const active = () => selected().includes(value)
          return (
            <button
              type="button"
              aria-pressed={active()}
              disabled={bool(item.disabled)}
              class={`${PILL} px-3 py-1.5 text-12-regular transition-colors ${HOVER} ${DISABLED} ${
                active() ? "border-v2-border-border-strong bg-v2-overlay-simple-overlay-hover text-v2-text-text-base" : "text-v2-text-text-muted"
              }`}
              onClick={() => toggle(value)}
            >
              {label}
            </button>
          )
        }}
      </For>
    </div>
  )
}

/**
 * Cards the user picks between. Selection is local to the renderer, and the
 * card body is model copy, so nothing here needs a translation.
 */
function OptionCardsField(input: RenderInput): JSX.Element {
  const field = useFormField()
  const multiple = text(input.props.type) === "multiple"
  const [selected, setSelected] = createSignal(initialChips(input.props.defaultValue, multiple))

  const toggle = (value: string) =>
    setSelected((current) => {
      if (current.includes(value)) return current.filter((item) => item !== value)
      return multiple ? [...current, value] : [value]
    })

  return (
    <div
      role="group"
      data-component="openui-option-cards"
      aria-labelledby={field.labelId}
      aria-describedby={field.hintId}
      aria-required={requiredRule(input.props.rules) ? true : undefined}
      class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2"
    >
      <For each={decls(input.props.items)}>
        {(item) => {
          const value = text(item.value) ?? ""
          const active = () => selected().includes(value)
          return (
            <button
              type="button"
              aria-pressed={active()}
              disabled={bool(item.disabled)}
              class={`flex min-w-0 flex-col gap-1 px-4 py-3 text-left transition-colors ${PANEL} ${HOVER} ${FOCUS} ${DISABLED} ${
                active() ? "border-v2-border-border-strong bg-v2-overlay-simple-overlay-hover" : ""
              }`}
              onClick={() => toggle(value)}
            >
              <span class={`truncate text-13-medium ${TEXT}`}>{text(item.title)}</span>
              <Show when={text(item.subtitle)}>
                <span class={`text-12-regular ${TEXT_MUTED}`}>{text(item.subtitle)}</span>
              </Show>
            </button>
          )
        }}
      </For>
    </div>
  )
}

// Declaration shapes: the parser resolves them to named props and a parent reads
// them with `decls(...)`, so rendering one directly draws nothing.
const DeclarationOnly: OpenUIComponentRenderer = () => null

type FormName =
  | "Form"
  | "FormControl"
  | "Label"
  | "Input"
  | "TextArea"
  | "Select"
  | "SelectItem"
  | "CheckBoxGroup"
  | "CheckBoxItem"
  | "RadioGroup"
  | "RadioItem"
  | "SwitchGroup"
  | "SwitchItem"
  | "Slider"
  | "Chips"
  | "ChipItem"
  | "OptionCards"
  | "OptionCard"

export const formRenderers: Record<FormName, OpenUIComponentRenderer> = {
  Form: FormContainer,
  FormControl: FormControlField,
  Label: LabelText,
  Input: InputField,
  TextArea: TextAreaField,
  Select: SelectField,
  SelectItem: DeclarationOnly,
  CheckBoxGroup: CheckBoxGroupField,
  CheckBoxItem: DeclarationOnly,
  RadioGroup: RadioGroupField,
  RadioItem: DeclarationOnly,
  SwitchGroup: SwitchGroupField,
  SwitchItem: DeclarationOnly,
  Slider: SliderField,
  Chips: ChipsField,
  ChipItem: DeclarationOnly,
  OptionCards: OptionCardsField,
  OptionCard: DeclarationOnly,
}
