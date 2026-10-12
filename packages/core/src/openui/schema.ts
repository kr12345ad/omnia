// GENERATED FILE — do not edit by hand.
// Source: thesysdev/openui @openuidev/react-ui openuiLibrary, pruned to the
// components the Solid renderer implements (see packages/core/src/openui/AGENTS.md).
// Regenerate with: bun run script/extract-openui-library.ts

import type { OpenUILibrarySchema } from "./types"

export const OPENUI_SCHEMA: OpenUILibrarySchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "Stack": {
      "$ref": "#/$defs/Stack"
    },
    "Separator": {
      "$ref": "#/$defs/Separator"
    },
    "Tabs": {
      "$ref": "#/$defs/Tabs"
    },
    "TabItem": {
      "$ref": "#/$defs/TabItem"
    },
    "Steps": {
      "$ref": "#/$defs/Steps"
    },
    "StepsItem": {
      "$ref": "#/$defs/StepsItem"
    },
    "Modal": {
      "$ref": "#/$defs/Modal"
    },
    "Card": {
      "$ref": "#/$defs/Card"
    },
    "CardHeader": {
      "$ref": "#/$defs/CardHeader"
    },
    "TextContent": {
      "$ref": "#/$defs/TextContent"
    },
    "MarkDownRenderer": {
      "$ref": "#/$defs/MarkDownRenderer"
    },
    "Callout": {
      "$ref": "#/$defs/Callout"
    },
    "TextCallout": {
      "$ref": "#/$defs/TextCallout"
    },
    "Image": {
      "$ref": "#/$defs/Image"
    },
    "ImageBlock": {
      "$ref": "#/$defs/ImageBlock"
    },
    "CodeBlock": {
      "$ref": "#/$defs/CodeBlock"
    },
    "InlineHeader": {
      "$ref": "#/$defs/InlineHeader"
    },
    "ListBlock": {
      "$ref": "#/$defs/ListBlock"
    },
    "ListItem": {
      "$ref": "#/$defs/ListItem"
    },
    "TagBlock": {
      "$ref": "#/$defs/TagBlock"
    },
    "Tag": {
      "$ref": "#/$defs/Tag"
    },
    "Icon": {
      "$ref": "#/$defs/Icon"
    },
    "EntityList": {
      "$ref": "#/$defs/EntityList"
    },
    "Text": {
      "$ref": "#/$defs/Text"
    },
    "BoldText": {
      "$ref": "#/$defs/BoldText"
    },
    "IconText": {
      "$ref": "#/$defs/IconText"
    },
    "MetricIndicatorInline": {
      "$ref": "#/$defs/MetricIndicatorInline"
    },
    "Table": {
      "$ref": "#/$defs/Table"
    },
    "Col": {
      "$ref": "#/$defs/Col"
    },
    "BarChart": {
      "$ref": "#/$defs/BarChart"
    },
    "LineChart": {
      "$ref": "#/$defs/LineChart"
    },
    "AreaChart": {
      "$ref": "#/$defs/AreaChart"
    },
    "PieChart": {
      "$ref": "#/$defs/PieChart"
    },
    "HorizontalBarChart": {
      "$ref": "#/$defs/HorizontalBarChart"
    },
    "SingleStackedBarChart": {
      "$ref": "#/$defs/SingleStackedBarChart"
    },
    "Series": {
      "$ref": "#/$defs/Series"
    },
    "Form": {
      "$ref": "#/$defs/Form"
    },
    "FormControl": {
      "$ref": "#/$defs/FormControl"
    },
    "Label": {
      "$ref": "#/$defs/Label"
    },
    "Input": {
      "$ref": "#/$defs/Input"
    },
    "TextArea": {
      "$ref": "#/$defs/TextArea"
    },
    "Select": {
      "$ref": "#/$defs/Select"
    },
    "SelectItem": {
      "$ref": "#/$defs/SelectItem"
    },
    "CheckBoxGroup": {
      "$ref": "#/$defs/CheckBoxGroup"
    },
    "CheckBoxItem": {
      "$ref": "#/$defs/CheckBoxItem"
    },
    "RadioGroup": {
      "$ref": "#/$defs/RadioGroup"
    },
    "RadioItem": {
      "$ref": "#/$defs/RadioItem"
    },
    "SwitchGroup": {
      "$ref": "#/$defs/SwitchGroup"
    },
    "SwitchItem": {
      "$ref": "#/$defs/SwitchItem"
    },
    "Slider": {
      "$ref": "#/$defs/Slider"
    },
    "Chips": {
      "$ref": "#/$defs/Chips"
    },
    "ChipItem": {
      "$ref": "#/$defs/ChipItem"
    },
    "OptionCards": {
      "$ref": "#/$defs/OptionCards"
    },
    "OptionCard": {
      "$ref": "#/$defs/OptionCard"
    },
    "Buttons": {
      "$ref": "#/$defs/Buttons"
    },
    "Button": {
      "$ref": "#/$defs/Button"
    },
    "IconButton": {
      "$ref": "#/$defs/IconButton"
    }
  },
  "required": [
    "Stack",
    "Separator",
    "Tabs",
    "TabItem",
    "Steps",
    "StepsItem",
    "Modal",
    "Card",
    "CardHeader",
    "TextContent",
    "MarkDownRenderer",
    "Callout",
    "TextCallout",
    "Image",
    "ImageBlock",
    "CodeBlock",
    "InlineHeader",
    "ListBlock",
    "ListItem",
    "TagBlock",
    "Tag",
    "Icon",
    "EntityList",
    "Text",
    "BoldText",
    "IconText",
    "MetricIndicatorInline",
    "Table",
    "Col",
    "BarChart",
    "LineChart",
    "AreaChart",
    "PieChart",
    "HorizontalBarChart",
    "SingleStackedBarChart",
    "Series",
    "Form",
    "FormControl",
    "Label",
    "Input",
    "TextArea",
    "Select",
    "SelectItem",
    "CheckBoxGroup",
    "CheckBoxItem",
    "RadioGroup",
    "RadioItem",
    "SwitchGroup",
    "SwitchItem",
    "Slider",
    "Chips",
    "ChipItem",
    "OptionCards",
    "OptionCard",
    "Buttons",
    "Button",
    "IconButton"
  ],
  "additionalProperties": false,
  "$defs": {
    "Stack": {
      "type": "object",
      "properties": {
        "children": {
          "type": "array",
          "items": {}
        },
        "direction": {
          "type": "string",
          "enum": [
            "row",
            "column"
          ]
        },
        "gap": {
          "type": "string",
          "enum": [
            "none",
            "xs",
            "s",
            "m",
            "l",
            "xl",
            "2xl"
          ]
        },
        "align": {
          "type": "string",
          "enum": [
            "start",
            "center",
            "end",
            "stretch",
            "baseline"
          ]
        },
        "justify": {
          "type": "string",
          "enum": [
            "start",
            "center",
            "end",
            "between",
            "around",
            "evenly"
          ]
        },
        "wrap": {
          "type": "boolean"
        }
      },
      "required": [
        "children"
      ],
      "additionalProperties": false,
      "id": "Stack",
      "description": "Flex container. direction: \"row\"|\"column\" (default \"column\"). gap: \"none\"|\"xs\"|\"s\"|\"m\"|\"l\"|\"xl\"|\"2xl\" (default \"m\"). align: \"start\"|\"center\"|\"end\"|\"stretch\"|\"baseline\". justify: \"start\"|\"center\"|\"end\"|\"between\"|\"around\"|\"evenly\"."
    },
    "Separator": {
      "type": "object",
      "properties": {
        "orientation": {
          "type": "string",
          "enum": [
            "horizontal",
            "vertical"
          ]
        },
        "decorative": {
          "type": "boolean"
        }
      },
      "additionalProperties": false,
      "id": "Separator",
      "description": "Visual divider between content sections"
    },
    "Tabs": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TabItem"
          }
        }
      },
      "required": [
        "items"
      ],
      "additionalProperties": false,
      "id": "Tabs",
      "description": "Tabbed container"
    },
    "TabItem": {
      "type": "object",
      "properties": {
        "value": {
          "type": "string"
        },
        "trigger": {
          "type": "string"
        },
        "content": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "$ref": "#/$defs/TextContent"
              },
              {
                "$ref": "#/$defs/MarkDownRenderer"
              },
              {
                "$ref": "#/$defs/CardHeader"
              },
              {
                "$ref": "#/$defs/Callout"
              },
              {
                "$ref": "#/$defs/TextCallout"
              },
              {
                "$ref": "#/$defs/CodeBlock"
              },
              {
                "$ref": "#/$defs/Image"
              },
              {
                "$ref": "#/$defs/ImageBlock"
              },
              {
                "$ref": "#/$defs/ImageGallery"
              },
              {
                "$ref": "#/$defs/Separator"
              },
              {
                "$ref": "#/$defs/HorizontalBarChart"
              },
              {
                "$ref": "#/$defs/RadarChart"
              },
              {
                "$ref": "#/$defs/PieChart"
              },
              {
                "$ref": "#/$defs/RadialChart"
              },
              {
                "$ref": "#/$defs/SingleStackedBarChart"
              },
              {
                "$ref": "#/$defs/ScatterChart"
              },
              {
                "$ref": "#/$defs/AreaChart"
              },
              {
                "$ref": "#/$defs/BarChart"
              },
              {
                "$ref": "#/$defs/LineChart"
              },
              {
                "$ref": "#/$defs/Table"
              },
              {
                "$ref": "#/$defs/TagBlock"
              },
              {
                "$ref": "#/$defs/Form"
              },
              {
                "$ref": "#/$defs/Buttons"
              },
              {
                "$ref": "#/$defs/IconButton"
              },
              {
                "$ref": "#/$defs/Steps"
              },
              {
                "$ref": "#/$defs/InlineHeader"
              },
              {
                "$ref": "#/$defs/EntityList"
              },
              {
                "$ref": "#/$defs/EditableTable"
              },
              {
                "$ref": "#/$defs/SnippetCardBlock"
              },
              {
                "$ref": "#/$defs/OverviewCardBlock"
              },
              {
                "$ref": "#/$defs/ContextCardBlock"
              },
              {
                "$ref": "#/$defs/CompositeCardBlock"
              },
              {
                "$ref": "#/$defs/VisualCardBlock"
              }
            ]
          }
        }
      },
      "required": [
        "value",
        "trigger",
        "content"
      ],
      "additionalProperties": false,
      "id": "TabItem",
      "description": "value is unique id, trigger is tab label, content is array of components"
    },
    "TextContent": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string"
        },
        "size": {
          "type": "string",
          "enum": [
            "small",
            "default",
            "large",
            "small-heavy",
            "large-heavy"
          ]
        }
      },
      "required": [
        "text"
      ],
      "additionalProperties": false,
      "id": "TextContent",
      "description": "Text block. Supports markdown. Optional size: \"small\" | \"default\" | \"large\" | \"small-heavy\" | \"large-heavy\"."
    },
    "MarkDownRenderer": {
      "type": "object",
      "properties": {
        "textMarkdown": {
          "type": "string"
        },
        "variant": {
          "type": "string",
          "enum": [
            "clear",
            "card",
            "sunk"
          ]
        }
      },
      "required": [
        "textMarkdown"
      ],
      "additionalProperties": false,
      "id": "MarkDownRenderer",
      "description": "Renders markdown text with optional container variant"
    },
    "CardHeader": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "subtitle": {
          "type": "string"
        }
      },
      "additionalProperties": false,
      "id": "CardHeader",
      "description": "Header with optional title and subtitle"
    },
    "Callout": {
      "type": "object",
      "properties": {
        "variant": {
          "type": "string",
          "enum": [
            "info",
            "warning",
            "error",
            "success",
            "neutral"
          ]
        },
        "title": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "visible": {
          "type": "boolean"
        }
      },
      "required": [
        "variant",
        "title",
        "description"
      ],
      "additionalProperties": false,
      "id": "Callout",
      "description": "Callout banner. Optional visible is a reactive $boolean — auto-dismisses after 3s by setting $visible to false."
    },
    "TextCallout": {
      "type": "object",
      "properties": {
        "variant": {
          "type": "string",
          "enum": [
            "neutral",
            "info",
            "warning",
            "success",
            "danger"
          ]
        },
        "title": {
          "type": "string"
        },
        "description": {
          "type": "string"
        }
      },
      "additionalProperties": false,
      "id": "TextCallout",
      "description": "Text callout with variant, title, and description"
    },
    "CodeBlock": {
      "type": "object",
      "properties": {
        "language": {
          "type": "string"
        },
        "codeString": {
          "type": "string"
        }
      },
      "required": [
        "language",
        "codeString"
      ],
      "additionalProperties": false,
      "id": "CodeBlock",
      "description": "Syntax-highlighted code block"
    },
    "Image": {
      "type": "object",
      "properties": {
        "alt": {
          "type": "string"
        },
        "src": {
          "type": "string"
        }
      },
      "required": [
        "alt"
      ],
      "additionalProperties": false,
      "id": "Image",
      "description": "Image with alt text and optional URL"
    },
    "ImageBlock": {
      "type": "object",
      "properties": {
        "src": {
          "type": "string"
        },
        "alt": {
          "type": "string"
        }
      },
      "required": [
        "src"
      ],
      "additionalProperties": false,
      "id": "ImageBlock",
      "description": "Image block with loading state"
    },
    "ImageGallery": {
      "type": "object",
      "properties": {
        "images": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "src": {
                "type": "string"
              },
              "alt": {
                "type": "string"
              },
              "details": {
                "type": "string"
              }
            },
            "required": [
              "src"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "images"
      ],
      "additionalProperties": false,
      "id": "ImageGallery",
      "description": "Gallery grid of images with modal preview"
    },
    "HorizontalBarChart": {
      "type": "object",
      "properties": {
        "labels": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "series": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Series"
          }
        },
        "variant": {
          "type": "string",
          "enum": [
            "grouped",
            "stacked"
          ]
        },
        "xLabel": {
          "type": "string"
        },
        "yLabel": {
          "type": "string"
        }
      },
      "required": [
        "labels",
        "series"
      ],
      "additionalProperties": false,
      "id": "HorizontalBarChart",
      "description": "Horizontal bars; prefer when category labels are long or for ranked lists"
    },
    "Series": {
      "type": "object",
      "properties": {
        "category": {
          "type": "string"
        },
        "values": {
          "type": "array",
          "items": {
            "type": "number"
          }
        }
      },
      "required": [
        "category",
        "values"
      ],
      "additionalProperties": false,
      "id": "Series",
      "description": "One data series"
    },
    "RadarChart": {
      "type": "object",
      "properties": {
        "labels": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "series": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Series"
          }
        }
      },
      "required": [
        "labels",
        "series"
      ],
      "additionalProperties": false,
      "id": "RadarChart",
      "description": "Spider/web chart; use for comparing multiple variables across one or more entities"
    },
    "PieChart": {
      "type": "object",
      "properties": {
        "labels": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "values": {
          "type": "array",
          "items": {
            "type": "number"
          }
        },
        "variant": {
          "type": "string",
          "enum": [
            "pie",
            "donut"
          ]
        },
        "appearance": {
          "type": "string",
          "enum": [
            "circular",
            "semiCircular"
          ]
        }
      },
      "required": [
        "labels",
        "values"
      ],
      "additionalProperties": false,
      "id": "PieChart",
      "description": "Circular slices; use plucked arrays: PieChart(data.categories, data.values)"
    },
    "RadialChart": {
      "type": "object",
      "properties": {
        "labels": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "values": {
          "type": "array",
          "items": {
            "type": "number"
          }
        }
      },
      "required": [
        "labels",
        "values"
      ],
      "additionalProperties": false,
      "id": "RadialChart",
      "description": "Radial bars; use plucked arrays: RadialChart(data.categories, data.values)"
    },
    "SingleStackedBarChart": {
      "type": "object",
      "properties": {
        "labels": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "values": {
          "type": "array",
          "items": {
            "type": "number"
          }
        }
      },
      "required": [
        "labels",
        "values"
      ],
      "additionalProperties": false,
      "id": "SingleStackedBarChart",
      "description": "Single horizontal stacked bar; use plucked arrays: SingleStackedBarChart(data.categories, data.values)"
    },
    "ScatterChart": {
      "type": "object",
      "properties": {
        "datasets": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ScatterSeries"
          }
        },
        "xLabel": {
          "type": "string"
        },
        "yLabel": {
          "type": "string"
        }
      },
      "required": [
        "datasets"
      ],
      "additionalProperties": false,
      "id": "ScatterChart",
      "description": "X/Y scatter plot; use for correlations, distributions, and clustering"
    },
    "ScatterSeries": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "points": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Point"
          }
        }
      },
      "required": [
        "name",
        "points"
      ],
      "additionalProperties": false,
      "id": "ScatterSeries",
      "description": "Named dataset"
    },
    "Point": {
      "type": "object",
      "properties": {
        "x": {
          "type": "number"
        },
        "y": {
          "type": "number"
        },
        "z": {
          "type": "number"
        }
      },
      "required": [
        "x",
        "y"
      ],
      "additionalProperties": false,
      "id": "Point",
      "description": "Data point with numeric coordinates"
    },
    "AreaChart": {
      "type": "object",
      "properties": {
        "labels": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "series": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Series"
          }
        },
        "variant": {
          "type": "string",
          "enum": [
            "linear",
            "natural",
            "step"
          ]
        },
        "xLabel": {
          "type": "string"
        },
        "yLabel": {
          "type": "string"
        },
        "height": {
          "type": "number"
        }
      },
      "required": [
        "labels",
        "series"
      ],
      "additionalProperties": false,
      "id": "AreaChart",
      "description": "Filled area under lines; use for cumulative totals or volume trends over time"
    },
    "BarChart": {
      "type": "object",
      "properties": {
        "labels": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "series": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Series"
          }
        },
        "variant": {
          "type": "string",
          "enum": [
            "grouped",
            "stacked"
          ]
        },
        "xLabel": {
          "type": "string"
        },
        "yLabel": {
          "type": "string"
        },
        "height": {
          "type": "number"
        }
      },
      "required": [
        "labels",
        "series"
      ],
      "additionalProperties": false,
      "id": "BarChart",
      "description": "Vertical bars; use for comparing values across categories with one or more series"
    },
    "LineChart": {
      "type": "object",
      "properties": {
        "labels": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "series": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Series"
          }
        },
        "variant": {
          "type": "string",
          "enum": [
            "linear",
            "natural",
            "step"
          ]
        },
        "xLabel": {
          "type": "string"
        },
        "yLabel": {
          "type": "string"
        },
        "height": {
          "type": "number"
        }
      },
      "required": [
        "labels",
        "series"
      ],
      "additionalProperties": false,
      "id": "LineChart",
      "description": "Lines over categories; use for trends and continuous data over time"
    },
    "Table": {
      "type": "object",
      "properties": {
        "columns": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Col"
          }
        }
      },
      "required": [
        "columns"
      ],
      "additionalProperties": false,
      "id": "Table",
      "description": "Data table — column-oriented. Each Col holds its own data array."
    },
    "Col": {
      "type": "object",
      "properties": {
        "label": {
          "type": "string"
        },
        "data": {},
        "type": {
          "type": "string",
          "enum": [
            "string",
            "number",
            "action"
          ]
        }
      },
      "required": [
        "label",
        "data"
      ],
      "additionalProperties": false,
      "id": "Col",
      "description": "Column definition — holds label + data array"
    },
    "TagBlock": {
      "type": "object",
      "properties": {
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "size": {
          "type": "string",
          "enum": [
            "sm",
            "md",
            "lg"
          ]
        }
      },
      "required": [
        "tags"
      ],
      "additionalProperties": false,
      "id": "TagBlock",
      "description": "tags is an array of strings; optional size sm | md | lg"
    },
    "Form": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "buttons": {
          "$ref": "#/$defs/Buttons"
        },
        "fields": {
          "default": [],
          "type": "array",
          "items": {
            "$ref": "#/$defs/FormControl"
          }
        }
      },
      "required": [
        "name",
        "buttons",
        "fields"
      ],
      "additionalProperties": false,
      "id": "Form",
      "description": "Form container with fields and explicit action buttons"
    },
    "Buttons": {
      "type": "object",
      "properties": {
        "buttons": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Button"
          }
        },
        "direction": {
          "type": "string",
          "enum": [
            "row",
            "column"
          ]
        }
      },
      "required": [
        "buttons"
      ],
      "additionalProperties": false,
      "id": "Buttons",
      "description": "Group of Button components. direction: \"row\" (default) | \"column\"."
    },
    "Button": {
      "type": "object",
      "properties": {
        "label": {
          "type": "string"
        },
        "action": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "open_url"
                },
                "url": {
                  "type": "string"
                }
              },
              "required": [
                "type",
                "url"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "continue_conversation"
                },
                "context": {
                  "type": "string"
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string"
                },
                "params": {
                  "type": "object",
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {}
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            }
          ]
        },
        "variant": {
          "type": "string",
          "enum": [
            "primary",
            "secondary",
            "tertiary"
          ]
        },
        "type": {
          "type": "string",
          "enum": [
            "normal",
            "destructive"
          ]
        },
        "size": {
          "type": "string",
          "enum": [
            "extra-small",
            "small",
            "medium",
            "large"
          ]
        }
      },
      "required": [
        "label"
      ],
      "additionalProperties": false,
      "id": "Button",
      "description": "Clickable button"
    },
    "FormControl": {
      "type": "object",
      "properties": {
        "label": {
          "type": "string"
        },
        "input": {
          "anyOf": [
            {
              "$ref": "#/$defs/Input"
            },
            {
              "$ref": "#/$defs/TextArea"
            },
            {
              "$ref": "#/$defs/Select"
            },
            {
              "$ref": "#/$defs/DatePicker"
            },
            {
              "$ref": "#/$defs/Slider"
            },
            {
              "$ref": "#/$defs/CheckBoxGroup"
            },
            {
              "$ref": "#/$defs/RadioGroup"
            },
            {
              "$ref": "#/$defs/Chips"
            },
            {
              "$ref": "#/$defs/OptionCards"
            }
          ]
        },
        "hint": {
          "type": "string"
        }
      },
      "required": [
        "label",
        "input"
      ],
      "additionalProperties": false,
      "id": "FormControl",
      "description": "Field with label, input component, and optional hint text"
    },
    "Input": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "placeholder": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "enum": [
            "text",
            "email",
            "password",
            "number",
            "url"
          ]
        },
        "rules": {
          "type": "object",
          "properties": {
            "required": {
              "type": "boolean"
            },
            "email": {
              "type": "boolean"
            },
            "url": {
              "type": "boolean"
            },
            "numeric": {
              "type": "boolean"
            },
            "min": {
              "type": "number"
            },
            "max": {
              "type": "number"
            },
            "minLength": {
              "type": "number"
            },
            "maxLength": {
              "type": "number"
            },
            "pattern": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        "value": {
          "type": "string"
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false,
      "id": "Input"
    },
    "TextArea": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "placeholder": {
          "type": "string"
        },
        "rows": {
          "type": "number"
        },
        "rules": {
          "type": "object",
          "properties": {
            "required": {
              "type": "boolean"
            },
            "email": {
              "type": "boolean"
            },
            "url": {
              "type": "boolean"
            },
            "numeric": {
              "type": "boolean"
            },
            "min": {
              "type": "number"
            },
            "max": {
              "type": "number"
            },
            "minLength": {
              "type": "number"
            },
            "maxLength": {
              "type": "number"
            },
            "pattern": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        "value": {
          "type": "string"
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false,
      "id": "TextArea"
    },
    "Select": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/SelectItem"
          }
        },
        "placeholder": {
          "type": "string"
        },
        "rules": {
          "type": "object",
          "properties": {
            "required": {
              "type": "boolean"
            },
            "email": {
              "type": "boolean"
            },
            "url": {
              "type": "boolean"
            },
            "numeric": {
              "type": "boolean"
            },
            "min": {
              "type": "number"
            },
            "max": {
              "type": "number"
            },
            "minLength": {
              "type": "number"
            },
            "maxLength": {
              "type": "number"
            },
            "pattern": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        "value": {
          "type": "string"
        },
        "size": {
          "type": "string",
          "enum": [
            "small",
            "medium",
            "large"
          ]
        }
      },
      "required": [
        "name",
        "items"
      ],
      "additionalProperties": false,
      "id": "Select"
    },
    "SelectItem": {
      "type": "object",
      "properties": {
        "value": {
          "type": "string"
        },
        "label": {
          "type": "string"
        }
      },
      "required": [
        "value",
        "label"
      ],
      "additionalProperties": false,
      "id": "SelectItem",
      "description": "Option for Select"
    },
    "DatePicker": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "mode": {
          "type": "string",
          "enum": [
            "single",
            "range"
          ]
        },
        "rules": {
          "type": "object",
          "properties": {
            "required": {
              "type": "boolean"
            },
            "email": {
              "type": "boolean"
            },
            "url": {
              "type": "boolean"
            },
            "numeric": {
              "type": "boolean"
            },
            "min": {
              "type": "number"
            },
            "max": {
              "type": "number"
            },
            "minLength": {
              "type": "number"
            },
            "maxLength": {
              "type": "number"
            },
            "pattern": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        "value": {}
      },
      "required": [
        "name"
      ],
      "additionalProperties": false,
      "id": "DatePicker"
    },
    "Slider": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "variant": {
          "type": "string",
          "enum": [
            "continuous",
            "discrete"
          ]
        },
        "min": {
          "type": "number"
        },
        "max": {
          "type": "number"
        },
        "step": {
          "type": "number"
        },
        "defaultValue": {
          "type": "array",
          "items": {
            "type": "number"
          }
        },
        "label": {
          "type": "string"
        },
        "rules": {
          "type": "object",
          "properties": {
            "required": {
              "type": "boolean"
            },
            "email": {
              "type": "boolean"
            },
            "url": {
              "type": "boolean"
            },
            "numeric": {
              "type": "boolean"
            },
            "min": {
              "type": "number"
            },
            "max": {
              "type": "number"
            },
            "minLength": {
              "type": "number"
            },
            "maxLength": {
              "type": "number"
            },
            "pattern": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        "value": {
          "type": "array",
          "items": {
            "type": "number"
          }
        }
      },
      "required": [
        "name",
        "variant",
        "min",
        "max"
      ],
      "additionalProperties": false,
      "id": "Slider",
      "description": "Numeric slider input; supports continuous and discrete (stepped) variants"
    },
    "CheckBoxGroup": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/CheckBoxItem"
          }
        },
        "rules": {
          "type": "object",
          "properties": {
            "required": {
              "type": "boolean"
            },
            "email": {
              "type": "boolean"
            },
            "url": {
              "type": "boolean"
            },
            "numeric": {
              "type": "boolean"
            },
            "min": {
              "type": "number"
            },
            "max": {
              "type": "number"
            },
            "minLength": {
              "type": "number"
            },
            "maxLength": {
              "type": "number"
            },
            "pattern": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        "value": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {
            "type": "boolean"
          }
        }
      },
      "required": [
        "name",
        "items"
      ],
      "additionalProperties": false,
      "id": "CheckBoxGroup"
    },
    "CheckBoxItem": {
      "type": "object",
      "properties": {
        "label": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "defaultChecked": {
          "type": "boolean"
        }
      },
      "required": [
        "label",
        "description",
        "name"
      ],
      "additionalProperties": false,
      "id": "CheckBoxItem"
    },
    "RadioGroup": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/RadioItem"
          }
        },
        "defaultValue": {
          "type": "string"
        },
        "rules": {
          "type": "object",
          "properties": {
            "required": {
              "type": "boolean"
            },
            "email": {
              "type": "boolean"
            },
            "url": {
              "type": "boolean"
            },
            "numeric": {
              "type": "boolean"
            },
            "min": {
              "type": "number"
            },
            "max": {
              "type": "number"
            },
            "minLength": {
              "type": "number"
            },
            "maxLength": {
              "type": "number"
            },
            "pattern": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        "value": {
          "type": "string"
        }
      },
      "required": [
        "name",
        "items"
      ],
      "additionalProperties": false,
      "id": "RadioGroup"
    },
    "RadioItem": {
      "type": "object",
      "properties": {
        "label": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "value": {
          "type": "string"
        }
      },
      "required": [
        "label",
        "description",
        "value"
      ],
      "additionalProperties": false,
      "id": "RadioItem"
    },
    "Chips": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "type": {
          "default": "multiple",
          "type": "string",
          "enum": [
            "single",
            "multiple"
          ]
        },
        "items": {
          "default": [],
          "type": "array",
          "items": {
            "$ref": "#/$defs/ChipItem"
          }
        },
        "rules": {
          "type": "object",
          "properties": {
            "required": {
              "type": "boolean"
            },
            "email": {
              "type": "boolean"
            },
            "url": {
              "type": "boolean"
            },
            "numeric": {
              "type": "boolean"
            },
            "min": {
              "type": "number"
            },
            "max": {
              "type": "number"
            },
            "minLength": {
              "type": "number"
            },
            "maxLength": {
              "type": "number"
            },
            "pattern": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        "defaultValue": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        }
      },
      "required": [
        "name",
        "type",
        "items"
      ],
      "additionalProperties": false,
      "id": "Chips",
      "description": "A form field of compact selectable chips for choosing one or many short options; the selection is stored under `name`."
    },
    "ChipItem": {
      "type": "object",
      "properties": {
        "value": {
          "type": "string"
        },
        "label": {
          "type": "string"
        },
        "icon": {
          "$ref": "#/$defs/Icon"
        },
        "disabled": {
          "type": "boolean"
        }
      },
      "required": [
        "value",
        "label"
      ],
      "additionalProperties": false,
      "id": "ChipItem",
      "description": "A single selectable chip inside a Chips group, with a value, label and optional icon."
    },
    "Icon": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "category": {
          "type": "string"
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false,
      "id": "Icon",
      "description": "A lucide icon by kebab-case name (e.g. 'circle-check'). Optional category picks a topical fallback when the name doesn't resolve."
    },
    "OptionCards": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "type": {
          "default": "single",
          "type": "string",
          "enum": [
            "single",
            "multiple"
          ]
        },
        "items": {
          "default": [],
          "type": "array",
          "items": {
            "$ref": "#/$defs/OptionCard"
          }
        },
        "rules": {
          "type": "object",
          "properties": {
            "required": {
              "type": "boolean"
            },
            "email": {
              "type": "boolean"
            },
            "url": {
              "type": "boolean"
            },
            "numeric": {
              "type": "boolean"
            },
            "min": {
              "type": "number"
            },
            "max": {
              "type": "number"
            },
            "minLength": {
              "type": "number"
            },
            "maxLength": {
              "type": "number"
            },
            "pattern": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        "defaultValue": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        }
      },
      "required": [
        "name",
        "type",
        "items"
      ],
      "additionalProperties": false,
      "id": "OptionCards",
      "description": "A form field of selectable cards (title, optional subtitle, optional icon or image) laid out in a responsive grid for choosing one or many options; the selection is stored under `name`."
    },
    "OptionCard": {
      "type": "object",
      "properties": {
        "value": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "subtitle": {
          "type": "string"
        },
        "topContent": {
          "anyOf": [
            {
              "$ref": "#/$defs/Icon"
            },
            {
              "$ref": "#/$defs/Image"
            }
          ]
        },
        "disabled": {
          "type": "boolean"
        }
      },
      "required": [
        "value",
        "title"
      ],
      "additionalProperties": false,
      "id": "OptionCard",
      "description": "A single selectable card inside an OptionCards group, with a value, title, optional subtitle and an optional Icon or Image on top."
    },
    "IconButton": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "icon": {
          "$ref": "#/$defs/Icon"
        },
        "action": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "open_url"
                },
                "url": {
                  "type": "string"
                }
              },
              "required": [
                "type",
                "url"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "continue_conversation"
                },
                "context": {
                  "type": "string"
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string"
                },
                "params": {
                  "type": "object",
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {}
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            }
          ]
        },
        "variant": {
          "type": "string",
          "enum": [
            "primary",
            "secondary",
            "tertiary"
          ]
        },
        "size": {
          "type": "string",
          "enum": [
            "extra-small",
            "small",
            "medium",
            "large"
          ]
        },
        "shape": {
          "type": "string",
          "enum": [
            "square",
            "circle"
          ]
        }
      },
      "required": [
        "name",
        "icon"
      ],
      "additionalProperties": false,
      "id": "IconButton",
      "description": "Icon-only button. name is the accessible label and the action label; icon is an Icon; action fires on click."
    },
    "Steps": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/StepsItem"
          }
        }
      },
      "required": [
        "items"
      ],
      "additionalProperties": false,
      "id": "Steps",
      "description": "Step-by-step guide"
    },
    "StepsItem": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "details": {
          "type": "string"
        }
      },
      "required": [
        "title",
        "details"
      ],
      "additionalProperties": false,
      "id": "StepsItem",
      "description": "title and details text for one step"
    },
    "InlineHeader": {
      "type": "object",
      "properties": {
        "heading": {
          "type": "string"
        },
        "description": {
          "type": "string"
        }
      },
      "required": [
        "heading"
      ],
      "additionalProperties": false,
      "id": "InlineHeader",
      "description": "Compact section heading with an optional one-line description, for use inside cards."
    },
    "EntityList": {
      "type": "object",
      "properties": {
        "rows": {
          "default": [],
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "left": {
                "type": "string"
              },
              "right": {
                "type": "string"
              },
              "rightVariant": {
                "default": "text",
                "type": "string",
                "enum": [
                  "text",
                  "number"
                ]
              }
            },
            "required": [
              "left",
              "right",
              "rightVariant"
            ],
            "additionalProperties": false
          }
        },
        "size": {
          "default": "default",
          "type": "string",
          "enum": [
            "small",
            "default"
          ]
        },
        "header": {
          "type": "object",
          "properties": {
            "left": {
              "type": "string"
            },
            "right": {
              "type": "string"
            },
            "rightVariant": {
              "default": "text",
              "type": "string",
              "enum": [
                "text",
                "number"
              ]
            }
          },
          "required": [
            "left",
            "right",
            "rightVariant"
          ],
          "additionalProperties": false
        },
        "footer": {
          "type": "object",
          "properties": {
            "left": {
              "type": "string"
            },
            "right": {
              "type": "string"
            },
            "rightVariant": {
              "default": "text",
              "type": "string",
              "enum": [
                "text",
                "number"
              ]
            }
          },
          "required": [
            "left",
            "right",
            "rightVariant"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "rows",
        "size"
      ],
      "additionalProperties": false,
      "id": "EntityList",
      "description": "Two-column key/value rows (left label, right value). size 'default' supports optional header and footer rows; rightVariant 'number' uses tabular numbers."
    },
    "EditableTable": {
      "type": "object",
      "properties": {
        "name": {
          "default": "",
          "type": "string"
        },
        "columns": {
          "default": [],
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "text",
                  "number",
                  "date-single",
                  "select",
                  "url"
                ]
              },
              "key": {
                "default": "default",
                "type": "string"
              },
              "header": {
                "default": "",
                "type": "string"
              },
              "width": {
                "type": "number"
              },
              "options": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "value": {
                      "type": "string"
                    },
                    "label": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "value",
                    "label"
                  ],
                  "additionalProperties": false
                }
              }
            },
            "required": [
              "type",
              "key",
              "header"
            ],
            "additionalProperties": false
          }
        },
        "data": {
          "default": [],
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "values": {
                "type": "array",
                "items": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "number"
                    }
                  ]
                }
              }
            },
            "required": [
              "id",
              "values"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "name",
        "columns",
        "data"
      ],
      "additionalProperties": false,
      "id": "EditableTable",
      "description": "Spreadsheet-like table whose cells the user can edit inline (text, number, url, date, select columns); edits are saved back as a form field"
    },
    "SnippetCardBlock": {
      "type": "object",
      "properties": {
        "items": {
          "minItems": 2,
          "type": "array",
          "items": {
            "$ref": "#/$defs/SnippetCardItem"
          }
        },
        "layout": {
          "default": "grid",
          "type": "string",
          "enum": [
            "grid"
          ]
        },
        "responsive": {
          "default": true,
          "type": "boolean"
        },
        "action": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "open_url"
                },
                "url": {
                  "type": "string"
                }
              },
              "required": [
                "type",
                "url"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "continue_conversation"
                },
                "context": {
                  "type": "string"
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string"
                },
                "params": {
                  "type": "object",
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {}
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            }
          ]
        },
        "gap": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "items",
        "layout",
        "responsive"
      ],
      "additionalProperties": false,
      "id": "SnippetCardBlock",
      "description": "A responsive grid of compact label/value cards (2 per row) for showing several short facts side by side; optionally clickable with a shared action."
    },
    "SnippetCardItem": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "lhs": {
          "anyOf": [
            {
              "$ref": "#/$defs/IconText"
            },
            {
              "$ref": "#/$defs/ImageText"
            }
          ]
        },
        "rhs": {
          "anyOf": [
            {
              "$ref": "#/$defs/Text"
            },
            {
              "$ref": "#/$defs/BoldText"
            }
          ]
        }
      },
      "required": [
        "lhs"
      ],
      "additionalProperties": false,
      "id": "SnippetCardItem",
      "description": "One row-style snippet card: a label on the left (IconText or ImageText) and an optional value on the right (Text or BoldText)."
    },
    "IconText": {
      "type": "object",
      "properties": {
        "icon": {
          "$ref": "#/$defs/Icon"
        },
        "iconVariant": {
          "default": "neutral",
          "type": "string",
          "enum": [
            "neutral",
            "info",
            "success",
            "warning",
            "danger",
            "inverted",
            "filled",
            "soft"
          ]
        },
        "iconSize": {
          "default": "m",
          "type": "string",
          "enum": [
            "xs",
            "s",
            "m",
            "l",
            "xl",
            "sm",
            "md",
            "lg"
          ]
        },
        "title": {
          "type": "string"
        },
        "subtitle": {
          "type": "string"
        },
        "bold": {
          "default": false,
          "type": "boolean"
        },
        "layout": {
          "default": "horizontal",
          "type": "string",
          "enum": [
            "horizontal",
            "vertical"
          ]
        }
      },
      "required": [
        "icon",
        "iconVariant",
        "iconSize",
        "title",
        "bold",
        "layout"
      ],
      "additionalProperties": false,
      "id": "IconText",
      "description": "An icon badge with a title and optional subtitle, laid out horizontally or vertically. iconVariant sets the badge color."
    },
    "ImageText": {
      "type": "object",
      "properties": {
        "src": {
          "type": "string"
        },
        "alt": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "subtitle": {
          "type": "string"
        },
        "bold": {
          "default": false,
          "type": "boolean"
        },
        "layout": {
          "default": "horizontal",
          "type": "string",
          "enum": [
            "horizontal",
            "vertical"
          ]
        },
        "imageSize": {
          "type": "number"
        }
      },
      "required": [
        "src",
        "title",
        "bold",
        "layout"
      ],
      "additionalProperties": false,
      "id": "ImageText",
      "description": "A small square image (thumbnail/avatar) with a title and optional subtitle. src must be a real image URL."
    },
    "Text": {
      "type": "object",
      "properties": {
        "variant": {
          "default": "text",
          "type": "string",
          "enum": [
            "text",
            "number"
          ]
        },
        "value": {
          "type": "string"
        },
        "subtext": {
          "type": "string"
        },
        "subtextVariant": {
          "default": "text",
          "type": "string",
          "enum": [
            "text",
            "number",
            "metric"
          ]
        },
        "size": {
          "default": "sm",
          "type": "string",
          "enum": [
            "xs",
            "sm",
            "md",
            "lg"
          ]
        }
      },
      "required": [
        "variant",
        "value",
        "subtextVariant",
        "size"
      ],
      "additionalProperties": false,
      "id": "Text",
      "description": "Plain text line with optional subtext. variant 'number' uses tabular number styling; subtextVariant 'metric' colors a leading +/- subtext green/red."
    },
    "BoldText": {
      "type": "object",
      "properties": {
        "variant": {
          "default": "text",
          "type": "string",
          "enum": [
            "text",
            "number"
          ]
        },
        "value": {
          "type": "string"
        },
        "subtext": {
          "type": "string"
        },
        "subtextVariant": {
          "default": "text",
          "type": "string",
          "enum": [
            "text",
            "number",
            "metric"
          ]
        },
        "size": {
          "default": "sm",
          "type": "string",
          "enum": [
            "xs",
            "sm",
            "md",
            "lg"
          ]
        }
      },
      "required": [
        "variant",
        "value",
        "subtextVariant",
        "size"
      ],
      "additionalProperties": false,
      "id": "BoldText",
      "description": "Emphasized (bold) text line with optional subtext. variant 'number' uses tabular number styling; subtextVariant 'metric' colors a leading +/- subtext green/red."
    },
    "OverviewCardBlock": {
      "type": "object",
      "properties": {
        "items": {
          "minItems": 2,
          "type": "array",
          "items": {
            "$ref": "#/$defs/OverviewCardItem"
          }
        },
        "layout": {
          "default": "grid",
          "type": "string",
          "enum": [
            "grid",
            "carousel"
          ]
        },
        "responsive": {
          "default": true,
          "type": "boolean"
        },
        "action": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "open_url"
                },
                "url": {
                  "type": "string"
                }
              },
              "required": [
                "type",
                "url"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "continue_conversation"
                },
                "context": {
                  "type": "string"
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string"
                },
                "params": {
                  "type": "object",
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {}
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            }
          ]
        },
        "gap": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "items",
        "layout",
        "responsive"
      ],
      "additionalProperties": false,
      "id": "OverviewCardBlock",
      "description": "A grid or horizontal carousel of compact overview cards, each with a heading (icon/image/text) on top and an inline metric below; optionally clickable with a shared action."
    },
    "OverviewCardItem": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "top": {
          "anyOf": [
            {
              "$ref": "#/$defs/IconText"
            },
            {
              "$ref": "#/$defs/ImageText"
            },
            {
              "$ref": "#/$defs/Text"
            }
          ]
        },
        "bottom": {
          "$ref": "#/$defs/MetricIndicatorInline"
        }
      },
      "required": [
        "top"
      ],
      "additionalProperties": false,
      "id": "OverviewCardItem",
      "description": "One overview card: a heading slot at the top (IconText, ImageText or Text) and an optional MetricIndicatorInline at the bottom."
    },
    "MetricIndicatorInline": {
      "type": "object",
      "properties": {
        "value": {
          "type": "string"
        },
        "subtext": {
          "type": "string"
        },
        "trend": {
          "type": "object",
          "properties": {
            "direction": {
              "type": "string",
              "enum": [
                "up",
                "down"
              ]
            },
            "value": {
              "type": "number"
            }
          },
          "required": [
            "direction",
            "value"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "value"
      ],
      "additionalProperties": false,
      "id": "MetricIndicatorInline",
      "description": "Headline metric value with an optional +/- percentage trend and subtext, all on one line."
    },
    "ContextCardBlock": {
      "type": "object",
      "properties": {
        "items": {
          "minItems": 2,
          "type": "array",
          "items": {
            "$ref": "#/$defs/ContextCardItem"
          }
        },
        "layout": {
          "default": "grid",
          "type": "string",
          "enum": [
            "grid",
            "carousel"
          ]
        },
        "responsive": {
          "default": true,
          "type": "boolean"
        },
        "action": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "open_url"
                },
                "url": {
                  "type": "string"
                }
              },
              "required": [
                "type",
                "url"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "continue_conversation"
                },
                "context": {
                  "type": "string"
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string"
                },
                "params": {
                  "type": "object",
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {}
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            }
          ]
        },
        "gap": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "items",
        "layout",
        "responsive"
      ],
      "additionalProperties": false,
      "id": "ContextCardBlock",
      "description": "A grid or carousel of compact tinted context cards (title or tag plus a short bold body); an optional action makes every card clickable."
    },
    "ContextCardItem": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "title": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "$ref": "#/$defs/Tag"
            }
          ]
        },
        "body": {
          "type": "string"
        },
        "bgColor": {
          "type": "string",
          "enum": [
            "gray"
          ]
        },
        "bgImageSrc": {
          "type": "string"
        },
        "bgImageAlt": {
          "type": "string"
        }
      },
      "required": [
        "title"
      ],
      "additionalProperties": false,
      "id": "ContextCardItem",
      "description": "A single card inside a ContextCardBlock: a title (plain string or Tag), an optional markdown body, and an optional gray tint or background image."
    },
    "Tag": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string"
        },
        "icon": {
          "$ref": "#/$defs/Icon"
        },
        "size": {
          "type": "string",
          "enum": [
            "sm",
            "md",
            "lg"
          ]
        },
        "variant": {
          "type": "string",
          "enum": [
            "neutral",
            "info",
            "success",
            "warning",
            "danger"
          ]
        }
      },
      "required": [
        "text"
      ],
      "additionalProperties": false,
      "id": "Tag",
      "description": "Styled tag/badge with optional Icon and variant"
    },
    "CompositeCardBlock": {
      "type": "object",
      "properties": {
        "items": {
          "minItems": 2,
          "type": "array",
          "items": {
            "$ref": "#/$defs/CompositeCardItem"
          }
        },
        "layout": {
          "default": "grid",
          "type": "string",
          "enum": [
            "grid",
            "carousel"
          ]
        },
        "responsive": {
          "default": true,
          "type": "boolean"
        },
        "action": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "open_url"
                },
                "url": {
                  "type": "string"
                }
              },
              "required": [
                "type",
                "url"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "continue_conversation"
                },
                "context": {
                  "type": "string"
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string"
                },
                "params": {
                  "type": "object",
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {}
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            }
          ]
        },
        "gap": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "items",
        "layout",
        "responsive"
      ],
      "additionalProperties": false,
      "id": "CompositeCardBlock",
      "description": "A two-per-row grid or carousel of rich cards, each with an optional header, stacked body content (text, metrics, charts, lists, tags) and a price/button footer; an optional action makes every card clickable."
    },
    "CompositeCardItem": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "header": {
          "anyOf": [
            {
              "$ref": "#/$defs/IconText"
            },
            {
              "$ref": "#/$defs/ImageText"
            },
            {
              "$ref": "#/$defs/ImageTextLarge"
            },
            {
              "$ref": "#/$defs/Text"
            },
            {
              "$ref": "#/$defs/Image"
            }
          ]
        },
        "body": {
          "default": [],
          "type": "array",
          "items": {
            "anyOf": [
              {
                "$ref": "#/$defs/Text"
              },
              {
                "$ref": "#/$defs/BoldText"
              },
              {
                "$ref": "#/$defs/MetricIndicatorInline"
              },
              {
                "$ref": "#/$defs/IconText"
              },
              {
                "$ref": "#/$defs/Image"
              },
              {
                "$ref": "#/$defs/AreaChart"
              },
              {
                "$ref": "#/$defs/BarChart"
              },
              {
                "$ref": "#/$defs/LineChart"
              },
              {
                "$ref": "#/$defs/ListBlock"
              },
              {
                "$ref": "#/$defs/TagBlock"
              },
              {
                "$ref": "#/$defs/EntityList"
              }
            ]
          }
        },
        "footer": {
          "type": "object",
          "properties": {
            "price": {
              "anyOf": [
                {
                  "$ref": "#/$defs/BoldText"
                },
                {
                  "$ref": "#/$defs/MetricIndicatorWithStrikethrough"
                }
              ]
            },
            "button": {
              "$ref": "#/$defs/Button"
            }
          },
          "additionalProperties": false
        }
      },
      "required": [
        "body"
      ],
      "additionalProperties": false,
      "id": "CompositeCardItem",
      "description": "A single card inside a CompositeCardBlock: an optional header (icon/image/text), a stack of body elements (text, metrics, charts, lists, tags), and an optional price/button footer."
    },
    "ImageTextLarge": {
      "type": "object",
      "properties": {
        "src": {
          "type": "string"
        },
        "alt": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "subtitle": {
          "type": "string"
        },
        "bold": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "src",
        "title",
        "bold"
      ],
      "additionalProperties": false,
      "id": "ImageTextLarge",
      "description": "A full-width banner image above a bold title and optional subtitle. src must be a real image URL."
    },
    "ListBlock": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ListItem"
          }
        },
        "variant": {
          "type": "string",
          "enum": [
            "number",
            "image"
          ]
        },
        "size": {
          "type": "string",
          "enum": [
            "default",
            "small"
          ]
        }
      },
      "required": [
        "items"
      ],
      "additionalProperties": false,
      "id": "ListBlock",
      "description": "A list of items with number or image indicators. Each item can optionally have an action. size small renders a compact list."
    },
    "ListItem": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "subtitle": {
          "type": "string"
        },
        "image": {
          "type": "object",
          "properties": {
            "src": {
              "type": "string"
            },
            "alt": {
              "type": "string"
            }
          },
          "required": [
            "src",
            "alt"
          ],
          "additionalProperties": false
        },
        "actionLabel": {
          "type": "string"
        },
        "action": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "open_url"
                },
                "url": {
                  "type": "string"
                }
              },
              "required": [
                "type",
                "url"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "continue_conversation"
                },
                "context": {
                  "type": "string"
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string"
                },
                "params": {
                  "type": "object",
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {}
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "title"
      ],
      "additionalProperties": false,
      "id": "ListItem",
      "description": "Item in a ListBlock — displays a title with an optional subtitle and image. When action is provided, the item becomes clickable."
    },
    "MetricIndicatorWithStrikethrough": {
      "type": "object",
      "properties": {
        "value": {
          "type": "string"
        },
        "subtext": {
          "type": "string"
        },
        "previousValue": {
          "type": "string"
        },
        "trend": {
          "type": "object",
          "properties": {
            "direction": {
              "type": "string",
              "enum": [
                "up",
                "down"
              ]
            },
            "value": {
              "type": "number"
            }
          },
          "required": [
            "direction",
            "value"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "value"
      ],
      "additionalProperties": false,
      "id": "MetricIndicatorWithStrikethrough",
      "description": "Headline metric value with an optional struck-through previousValue, a +/- percentage trend, and subtext below."
    },
    "VisualCardBlock": {
      "type": "object",
      "properties": {
        "items": {
          "minItems": 2,
          "type": "array",
          "items": {
            "$ref": "#/$defs/VisualCardItem"
          }
        },
        "layout": {
          "default": "grid",
          "type": "string",
          "enum": [
            "grid",
            "carousel"
          ]
        },
        "responsive": {
          "default": true,
          "type": "boolean"
        },
        "action": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "open_url"
                },
                "url": {
                  "type": "string"
                }
              },
              "required": [
                "type",
                "url"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "continue_conversation"
                },
                "context": {
                  "type": "string"
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string"
                },
                "params": {
                  "type": "object",
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {}
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": false
            }
          ]
        },
        "gap": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "string"
            }
          ]
        }
      },
      "required": [
        "items",
        "layout",
        "responsive"
      ],
      "additionalProperties": false,
      "id": "VisualCardBlock",
      "description": "A grid or carousel of photo-first cards: a full-bleed background image with a tag on top and a bold text panel at the bottom; an optional action makes every card clickable."
    },
    "VisualCardItem": {
      "type": "object",
      "properties": {
        "body": {
          "$ref": "#/$defs/BoldText"
        },
        "id": {
          "type": "string"
        },
        "bgImageSrc": {
          "type": "string"
        },
        "tag": {
          "$ref": "#/$defs/Tag"
        },
        "bgImageAlt": {
          "type": "string"
        }
      },
      "required": [
        "body"
      ],
      "additionalProperties": false,
      "id": "VisualCardItem",
      "description": "A single photo-first card inside a VisualCardBlock: a BoldText body panel, an optional Tag, and a background image (bgImageSrc must be a real URL; bgImageAlt is its alt text)."
    },
    "Modal": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "open": {
          "type": "boolean"
        },
        "children": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "$ref": "#/$defs/TextContent"
              },
              {
                "$ref": "#/$defs/MarkDownRenderer"
              },
              {
                "$ref": "#/$defs/CardHeader"
              },
              {
                "$ref": "#/$defs/Callout"
              },
              {
                "$ref": "#/$defs/TextCallout"
              },
              {
                "$ref": "#/$defs/CodeBlock"
              },
              {
                "$ref": "#/$defs/Image"
              },
              {
                "$ref": "#/$defs/ImageBlock"
              },
              {
                "$ref": "#/$defs/ImageGallery"
              },
              {
                "$ref": "#/$defs/Separator"
              },
              {
                "$ref": "#/$defs/HorizontalBarChart"
              },
              {
                "$ref": "#/$defs/RadarChart"
              },
              {
                "$ref": "#/$defs/PieChart"
              },
              {
                "$ref": "#/$defs/RadialChart"
              },
              {
                "$ref": "#/$defs/SingleStackedBarChart"
              },
              {
                "$ref": "#/$defs/ScatterChart"
              },
              {
                "$ref": "#/$defs/AreaChart"
              },
              {
                "$ref": "#/$defs/BarChart"
              },
              {
                "$ref": "#/$defs/LineChart"
              },
              {
                "$ref": "#/$defs/Table"
              },
              {
                "$ref": "#/$defs/TagBlock"
              },
              {
                "$ref": "#/$defs/Form"
              },
              {
                "$ref": "#/$defs/Buttons"
              },
              {
                "$ref": "#/$defs/IconButton"
              },
              {
                "$ref": "#/$defs/Steps"
              },
              {
                "$ref": "#/$defs/InlineHeader"
              },
              {
                "$ref": "#/$defs/EntityList"
              },
              {
                "$ref": "#/$defs/EditableTable"
              },
              {
                "$ref": "#/$defs/SnippetCardBlock"
              },
              {
                "$ref": "#/$defs/OverviewCardBlock"
              },
              {
                "$ref": "#/$defs/ContextCardBlock"
              },
              {
                "$ref": "#/$defs/CompositeCardBlock"
              },
              {
                "$ref": "#/$defs/VisualCardBlock"
              }
            ]
          }
        },
        "size": {
          "type": "string",
          "enum": [
            "sm",
            "md",
            "lg"
          ]
        }
      },
      "required": [
        "title",
        "children"
      ],
      "additionalProperties": false,
      "id": "Modal",
      "description": "Modal dialog. open is a reactive $boolean binding — set to true to open, X/Escape/backdrop auto-closes. Put Form with buttons inside children."
    },
    "Card": {
      "type": "object",
      "properties": {
        "children": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "$ref": "#/$defs/TextContent"
              },
              {
                "$ref": "#/$defs/MarkDownRenderer"
              },
              {
                "$ref": "#/$defs/CardHeader"
              },
              {
                "$ref": "#/$defs/Callout"
              },
              {
                "$ref": "#/$defs/TextCallout"
              },
              {
                "$ref": "#/$defs/CodeBlock"
              },
              {
                "$ref": "#/$defs/Image"
              },
              {
                "$ref": "#/$defs/ImageBlock"
              },
              {
                "$ref": "#/$defs/ImageGallery"
              },
              {
                "$ref": "#/$defs/Separator"
              },
              {
                "$ref": "#/$defs/HorizontalBarChart"
              },
              {
                "$ref": "#/$defs/RadarChart"
              },
              {
                "$ref": "#/$defs/PieChart"
              },
              {
                "$ref": "#/$defs/RadialChart"
              },
              {
                "$ref": "#/$defs/SingleStackedBarChart"
              },
              {
                "$ref": "#/$defs/ScatterChart"
              },
              {
                "$ref": "#/$defs/AreaChart"
              },
              {
                "$ref": "#/$defs/BarChart"
              },
              {
                "$ref": "#/$defs/LineChart"
              },
              {
                "$ref": "#/$defs/Table"
              },
              {
                "$ref": "#/$defs/TagBlock"
              },
              {
                "$ref": "#/$defs/Form"
              },
              {
                "$ref": "#/$defs/Buttons"
              },
              {
                "$ref": "#/$defs/IconButton"
              },
              {
                "$ref": "#/$defs/Steps"
              },
              {
                "$ref": "#/$defs/InlineHeader"
              },
              {
                "$ref": "#/$defs/EntityList"
              },
              {
                "$ref": "#/$defs/EditableTable"
              },
              {
                "$ref": "#/$defs/SnippetCardBlock"
              },
              {
                "$ref": "#/$defs/OverviewCardBlock"
              },
              {
                "$ref": "#/$defs/ContextCardBlock"
              },
              {
                "$ref": "#/$defs/CompositeCardBlock"
              },
              {
                "$ref": "#/$defs/VisualCardBlock"
              },
              {
                "$ref": "#/$defs/Tabs"
              },
              {
                "$ref": "#/$defs/Carousel"
              },
              {
                "$ref": "#/$defs/Stack"
              }
            ]
          }
        },
        "variant": {
          "type": "string",
          "enum": [
            "card",
            "sunk",
            "clear"
          ]
        },
        "direction": {
          "type": "string",
          "enum": [
            "row",
            "column"
          ]
        },
        "gap": {
          "type": "string",
          "enum": [
            "none",
            "xs",
            "s",
            "m",
            "l",
            "xl",
            "2xl"
          ]
        },
        "align": {
          "type": "string",
          "enum": [
            "start",
            "center",
            "end",
            "stretch",
            "baseline"
          ]
        },
        "justify": {
          "type": "string",
          "enum": [
            "start",
            "center",
            "end",
            "between",
            "around",
            "evenly"
          ]
        },
        "wrap": {
          "type": "boolean"
        }
      },
      "required": [
        "children"
      ],
      "additionalProperties": false,
      "id": "Card",
      "description": "Styled container. variant: \"card\" (default, elevated) | \"sunk\" (recessed) | \"clear\" (transparent). Always full width. Accepts all Stack flex params (default: direction \"column\"). Cards flex to share space in row/wrap layouts."
    },
    "Carousel": {
      "type": "object",
      "properties": {
        "children": {
          "type": "array",
          "items": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/TextContent"
                },
                {
                  "$ref": "#/$defs/MarkDownRenderer"
                },
                {
                  "$ref": "#/$defs/CardHeader"
                },
                {
                  "$ref": "#/$defs/Callout"
                },
                {
                  "$ref": "#/$defs/TextCallout"
                },
                {
                  "$ref": "#/$defs/CodeBlock"
                },
                {
                  "$ref": "#/$defs/Image"
                },
                {
                  "$ref": "#/$defs/ImageBlock"
                },
                {
                  "$ref": "#/$defs/ImageGallery"
                },
                {
                  "$ref": "#/$defs/Separator"
                },
                {
                  "$ref": "#/$defs/HorizontalBarChart"
                },
                {
                  "$ref": "#/$defs/RadarChart"
                },
                {
                  "$ref": "#/$defs/PieChart"
                },
                {
                  "$ref": "#/$defs/RadialChart"
                },
                {
                  "$ref": "#/$defs/SingleStackedBarChart"
                },
                {
                  "$ref": "#/$defs/ScatterChart"
                },
                {
                  "$ref": "#/$defs/AreaChart"
                },
                {
                  "$ref": "#/$defs/BarChart"
                },
                {
                  "$ref": "#/$defs/LineChart"
                },
                {
                  "$ref": "#/$defs/Table"
                },
                {
                  "$ref": "#/$defs/TagBlock"
                },
                {
                  "$ref": "#/$defs/Form"
                },
                {
                  "$ref": "#/$defs/Buttons"
                },
                {
                  "$ref": "#/$defs/IconButton"
                },
                {
                  "$ref": "#/$defs/Steps"
                },
                {
                  "$ref": "#/$defs/InlineHeader"
                },
                {
                  "$ref": "#/$defs/EntityList"
                },
                {
                  "$ref": "#/$defs/EditableTable"
                },
                {
                  "$ref": "#/$defs/SnippetCardBlock"
                },
                {
                  "$ref": "#/$defs/OverviewCardBlock"
                },
                {
                  "$ref": "#/$defs/ContextCardBlock"
                },
                {
                  "$ref": "#/$defs/CompositeCardBlock"
                },
                {
                  "$ref": "#/$defs/VisualCardBlock"
                }
              ]
            }
          }
        },
        "variant": {
          "type": "string",
          "enum": [
            "card",
            "sunk"
          ]
        }
      },
      "required": [
        "children"
      ],
      "additionalProperties": false,
      "id": "Carousel",
      "description": "Horizontal scrollable carousel"
    },
    "Label": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string"
        }
      },
      "required": [
        "text"
      ],
      "additionalProperties": false,
      "id": "Label",
      "description": "Text label"
    },
    "SwitchGroup": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/SwitchItem"
          }
        },
        "variant": {
          "type": "string",
          "enum": [
            "clear",
            "card",
            "sunk"
          ]
        },
        "value": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {
            "type": "boolean"
          }
        }
      },
      "required": [
        "name",
        "items"
      ],
      "additionalProperties": false,
      "id": "SwitchGroup",
      "description": "Group of switch toggles"
    },
    "SwitchItem": {
      "type": "object",
      "properties": {
        "label": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "defaultChecked": {
          "type": "boolean"
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false,
      "id": "SwitchItem",
      "description": "Individual switch toggle"
    }
  }
}
