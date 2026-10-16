import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { frameScrollBridge } from "../frame-scroll"
import { num, text } from "../helpers"
import { CARD_PARAMETERS, CARD_PROGRAM_HEAD, CARD_PROGRAM_TAIL, cardSyntaxError } from "../program"
import { TEXT, TEXT_MUTED } from "../theme"
import type { OpenUIComponentRenderer, OpenUIRendererMap } from "../types"
import { Embedded, Frame, heightProp, SETTLE_MS, themeBridge, themeObject } from "./frame"

/**
 * `JsCard`: the component with no vocabulary behind it.
 *
 * Every other OpenUI component draws a shape the client already knows. `Html`
 * and `Svg` are markup, which is enough for a page or a diagram but not for a
 * rotating 3D scene, a force-directed graph, a canvas simulation or a card with
 * its own layout and controls. This one carries JavaScript, runs it in the same
 * kind of sandboxed frame, and hands it a small runtime: theme tokens, a size
 * that stays current, resize notifications, a device-pixel-ratio-correct canvas
 * and a way to ask for a taller card.
 *
 * The code arrives as one string that the model escaping rules already cover
 * (see `OPENUI_EXTENSION_PROMPT`), so the card is the same program stream as
 * every other component — it just happens to be a program inside a program.
 *
 * Two consequences are deliberate:
 *
 * - the script runs only once the code stops arriving (a frame re-mounts on
 *   every `srcdoc` change, so running mid-stream would restart it on each
 *   delta), which is why the card is the last thing in an answer to appear;
 * - it runs again whenever the card is re-created — a re-render of the answer,
 *   or the model continuing the same card. Scripts must build from data, never
 *   from what a previous run left behind.
 *
 * The code is also compiled before it is ever given a frame to run in, with the
 * same program the frame builds (`program.ts`). Code that does not compile is
 * reported in the answer itself — the reader's language, the engine's message —
 * instead of a stack trace printed inside the card, and a script that throws
 * while running sends its message out of the frame for the same notice.
 */

/** The frame this component owns: its slots and its channels are named after it. */
const NAME = "openui-js-card"

const DEFAULT_WIDTH = 100

/** A card narrower than a quarter of the column stops being readable. */
const MIN_WIDTH = 25
const MAX_WIDTH = 100

/** Beyond 2x the extra pixels are invisible on a chart and only cost frame time. */
const MAX_DEVICE_PIXEL_RATIO = 2

function widthProp(value: unknown) {
  const width = num(value)
  if (width === undefined) return DEFAULT_WIDTH
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)))
}

/** JSON-escaped for a `<script>` body: `<` never appears, so nothing can close the tag. */
function embed(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

/**
 * The runtime the card's code is called with, injected ahead of it.
 *
 * This runs in the frame, not in the app: it is plain ES5 so it cannot depend on
 * anything the bundler would have provided, and it is written to leak nothing
 * into the script's scope except the documented globals. The program it builds
 * is the one `program.ts` describes, so what the app compiled is what runs.
 *
 * `theme` is the palette (`theme.textTextBase`) read in `frame.tsx`, so a card can
 * color itself instead of picking a literal. `canvas()` is the one convenience
 * worth having: a full-bleed canvas that is already scaled for the device pixel
 * ratio, since getting that right is the part every generated chart gets wrong.
 */
function bootstrap(code: string, theme: Record<string, string>) {
  return `<script>(function(){
var CODE=${embed(code)};
var theme=${embed(theme)};
var root=document.getElementById("openui-js-root");
var dpr=Math.min(window.devicePixelRatio||1,${MAX_DEVICE_PIXEL_RATIO});
var size={width:root.clientWidth,height:root.clientHeight};
var listeners=[];
var onResize=function(callback){listeners.push(callback)};
var canvas=function(className){
  var element=document.createElement("canvas");
  if(className)element.className=className;
  element.style.display="block";element.style.width="100%";element.style.height="100%";
  root.appendChild(element);
  var ctx=element.getContext("2d");
  var fit=function(){
    var box=root.getBoundingClientRect();
    var width=Math.max(1,Math.round(box.width)),height=Math.max(1,Math.round(box.height));
    element.width=Math.round(width*dpr);element.height=Math.round(height*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    return {width:width,height:height}
  };
  fit();
  return {canvas:element,ctx:ctx,fit:fit}
};
var setHeight=function(next){
  var value=Math.round(Number(next));
  if(!isFinite(value)||value<=0)return;
  parent.postMessage({type:"openui-js-card-height",height:value},"*")
};
var measure=function(){size.width=root.clientWidth;size.height=root.clientHeight};
// A failure is the app's to report: the frame sends out what went wrong, and the
// card's box is replaced by a notice the app draws itself.
var fail=function(error){
  parent.postMessage({type:"openui-js-card-failed",message:(error&&error.message?error.message:String(error))},"*")
};
var drawn=false;
var draw=function(){
  if(drawn)return;
  measure();
  if(size.width<=0||size.height<=0)return;
  drawn=true;
  try{
    var start=new Function(${CARD_PARAMETERS.map(embed).join(",")},${embed(CARD_PROGRAM_HEAD)}+CODE+${embed(CARD_PROGRAM_TAIL)});
    Promise.resolve(start(root,theme,size,dpr,onResize,canvas,setHeight)).catch(fail)
  }catch(error){fail(error)}
};
new ResizeObserver(function(){
  measure();
  for(var i=0;i<listeners.length;i++)listeners[i](size);
  draw()
}).observe(root);
// A frame that has just been inserted has no box yet, and a script that measures
// itself would draw into 1px and stay that size, so the script waits for the
// first observation of a real box instead.
draw()
})()</script>`
}

/** The frame document: the theme bridge, a full-bleed root, and the card's code. */
function cardDocument(code: string) {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    // The bridge is still worth carrying: the script gets `theme` as an object,
    // but any markup it injects styles itself with `var(--v2-...)`.
    themeBridge(),
    // The card's body is its one scroll box, and it is a box deliberately: a
    // frame that scrolls the viewport instead would make the reader's gesture
    // and the app's forwarded one fight over the same offset. The viewport is
    // locked to the box the app gave the frame; what a card draws past it is
    // `body`'s overflow, which the frame reports and the app scrolls.
    "<style>html{margin:0;padding:0;height:100%;background:transparent;color:var(--v2-text-text-base);",
    'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden;overscroll-behavior:contain}',
    "body{margin:0;padding:0;height:100%;overflow:auto;overscroll-behavior:contain}#openui-js-root{width:100%;height:100%}</style>",
    '</head><body><div id="openui-js-root"></div>',
    // Before the card runs, so the box it was given is known by the time its
    // first draw asks for one.
    frameScrollBridge(NAME),
    bootstrap(code, themeObject()),
    "</body></html>",
  ].join("")
}

const JsCard: OpenUIComponentRenderer = ({ props }) => {
  const i18n = useI18n()
  const code = () => text(props.code) ?? ""
  const [settled, setSettled] = createSignal<string>()
  const [reported, setReported] = createSignal<string>()
  const [height, setHeight] = createSignal(heightProp(props.height))
  const [frame, setFrame] = createSignal<HTMLIFrameElement>()
  const width = () => `${widthProp(props.width)}%`

  // What the card cannot do, in the app's words: code that will not compile is
  // never given a frame, and a script that throws while running reports its
  // message out of the frame. Either way the failure is the answer's, not the
  // card document's.
  const failure = () => {
    const script = settled()
    if (script === undefined) return undefined
    const syntax = cardSyntaxError(script)
    if (syntax !== undefined) {
      return {
        title: i18n.t("ui.jsCard.invalid.title"),
        description: i18n.t("ui.jsCard.invalid.description", { message: syntax }),
      }
    }
    const thrown = reported()
    if (thrown === undefined) return undefined
    return {
      title: i18n.t("ui.jsCard.failed.title"),
      description: i18n.t("ui.jsCard.failed.description", { message: thrown }),
    }
  }

  // Streaming rewrites the script on every delta, and a frame re-mounts on each
  // rewrite, so the card is built once the code stops changing instead of
  // restarting a half-written program a dozen times. The settle is also where the
  // code is compiled: a program that will not compile is refused before it is
  // ever handed a frame to run in.
  createEffect(() => {
    const next = code()
    const timer = setTimeout(() => {
      // A failure belongs to the run it came from; the next script gets a fresh
      // frame and a fresh verdict.
      setReported(undefined)
      setSettled(next)
    }, SETTLE_MS)
    onCleanup(() => clearTimeout(timer))
  })

  // The card's two channels back to the app (`setHeight` and a script that
  // threw). Both are honored only from this card's own frame.
  createEffect(() => {
    const listen = (event: MessageEvent) => {
      const mounted = frame()
      if (!mounted || event.source !== mounted.contentWindow) return
      const data = event.data as { type?: unknown; height?: unknown; message?: unknown } | undefined
      if (data?.type === "openui-js-card-height") {
        const requested = num(data.height)
        if (requested === undefined) return
        setHeight(heightProp(requested))
        return
      }
      if (data?.type === "openui-js-card-failed") setReported(text(data.message) ?? "")
    }
    window.addEventListener("message", listen)
    onCleanup(() => window.removeEventListener("message", listen))
  })

  return (
    <Frame name={NAME} title={text(props.title)} height={height()} width={width()}>
      <Show
        when={failure()}
        fallback={
          <Show
            when={settled()}
            fallback={
              <div
                data-slot="openui-js-card-loading"
                class="flex items-center justify-center"
                style={{ height: `${height()}px` }}
              >
                <Spinner class="size-4" />
              </div>
            }
          >
            {(script) => (
              <Embedded
                name={NAME}
                title={text(props.title)}
                height={height()}
                srcDoc={cardDocument(script())}
                frame={setFrame}
              />
            )}
          </Show>
        }
      >
        {(problem) => (
          // The surface a generated `TextCallout` uses for a danger variant, so a
          // refused card reads as part of the answer.
          <div
            data-slot="openui-js-card-error"
            class="flex flex-col gap-0.5 rounded-xl border border-v2-state-border-danger bg-v2-state-bg-danger px-3 py-2.5"
          >
            <div class={`text-13-medium ${TEXT}`}>{problem().title}</div>
            <Show when={problem().description}>
              <div class={`text-12-regular break-words ${TEXT_MUTED}`}>{problem().description}</div>
            </Show>
          </div>
        )}
      </Show>
    </Frame>
  )
}

export const jsCardRenderers: OpenUIRendererMap = { JsCard }
