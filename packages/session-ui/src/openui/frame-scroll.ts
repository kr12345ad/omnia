/**
 * How an embedded frame's own scrolling is shared with the answer around it.
 *
 * A frame owns every gesture over its box, and a wheel inside one never chains
 * out of it. That made a card taller than its box scrollable in theory and not in
 * practice: with the pointer merely over the card, the wheel scrolled the answer
 * and the card sat still with a scrollbar the reader could see and not use.
 *
 * So the frame reports the scroll box it owns and obeys a delta the app hands it.
 * The app decides — from that report, before the browser has scrolled anything —
 * whether a wheel over the frame is the frame's or the answer's, and the frame
 * hands a gesture back once it runs past the frame's own edge. Reading a card
 * scrolls the card; reading past its end scrolls the answer, from where the card
 * stopped.
 *
 * `frameScrollBridge` is the frame's half, a string because it runs inside the
 * frame's own document, where nothing the bundler produced is available.
 */

/** The scroll box a frame owns, as the frame last reported it. */
export interface FrameScrollBox {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export type FrameScrollChannel = "state" | "scroll" | "overflow"

/**
 * The message one scroll channel of a frame carries, named after the component
 * that owns it. The delta the frame is asked to apply is the frame's scroll
 * message itself, so it is not named for a second time.
 */
export function frameScrollChannel(name: string, channel: FrameScrollChannel) {
  return channel === "scroll" ? `${name}-scroll` : `${name}-scroll-${channel}`
}

/** The scroll box in a frame's report, or `undefined` when the message is not a usable one. */
export function readFrameScrollBox(value: unknown): FrameScrollBox | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const message = value as Record<string, unknown>
  const scrollTop = finite(message.scrollTop)
  const scrollHeight = finite(message.scrollHeight)
  const clientHeight = finite(message.clientHeight)
  if (scrollTop === undefined || scrollHeight === undefined || clientHeight === undefined) return undefined
  return { scrollTop, scrollHeight, clientHeight }
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Whether the frame can still move by `delta` inside its own box.
 *
 * The tolerance is a pixel: a box whose content is a fractional height sits at
 * its end while `scrollTop + clientHeight` is a fraction short of `scrollHeight`,
 * and the wheel there belongs to the answer.
 */
export function canScrollFrame(box: FrameScrollBox, delta: number) {
  if (!delta) return false
  if (delta < 0) return box.scrollTop > 0
  return box.scrollTop + box.clientHeight < box.scrollHeight - 1
}

/** A wheel's vertical delta in pixels, the unit a frame scrolls by. */
export function wheelScrollDelta(event: { deltaY: number; deltaMode: number }, viewportHeight: number) {
  if (event.deltaMode === 1) return event.deltaY * 40
  if (event.deltaMode === 2) return event.deltaY * viewportHeight
  return event.deltaY
}

/**
 * The frame's half of the protocol, for the document an embedded frame runs.
 *
 * It reports the box it owns (on mount, on resize and on every scroll, including
 * a scroll it was asked for), applies a delta the app forwards, and hands a wheel
 * gesture back when its own box has nothing left to give — the frame cannot chain
 * a gesture out of itself, so the app does that part for it.
 *
 * The listener is deliberately non-passive: the hand-off only means anything if
 * the browser is stopped from treating the gesture as its own.
 */
export function frameScrollBridge(name: string) {
  return `<script>(function(){
var STATE=${JSON.stringify(frameScrollChannel(name, "state"))},SCROLL=${JSON.stringify(frameScrollChannel(name, "scroll"))},OVERFLOW=${JSON.stringify(frameScrollChannel(name, "overflow"))};
var post=function(message){parent.postMessage(message,"*")};
var scroller=function(){
  var candidates=[document.scrollingElement||document.documentElement,document.body||document.documentElement];
  for(var index=0;index<candidates.length;index++){
    var overflow=window.getComputedStyle(candidates[index]).overflowY;
    if(overflow!=="visible"&&overflow!=="hidden"&&overflow!=="clip")return candidates[index]
  }
  return candidates[0]
};
var report=function(){
  var element=scroller();
  post({type:STATE,scrollTop:element.scrollTop,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight})
};
var delta=function(event){
  if(event.deltaMode===1)return event.deltaY*40;
  if(event.deltaMode===2)return event.deltaY*(window.innerHeight||1);
  return event.deltaY
};
// A delta the app hands over is the gesture it already took away from itself, so
// it is applied here and nowhere else.
window.addEventListener("message",function(event){
  if(event.source!==parent)return;
  var message=event.data;
  if(!message||message.type!==SCROLL)return;
  var value=Number(message.delta);
  if(!isFinite(value)||!value)return;
  scroller().scrollTop+=value;
  report()
});
window.addEventListener("wheel",function(event){
  var value=delta(event);
  if(!value)return;
  var element=scroller();
  var end=Math.max(0,element.scrollHeight-element.clientHeight);
  var next=Math.max(0,Math.min(end,element.scrollTop+value));
  // The frame can move: the browser scrolls it, exactly like any other box.
  if(next!==element.scrollTop)return;
  event.preventDefault();
  post({type:OVERFLOW,delta:value})
},{passive:false});
window.addEventListener("scroll",report,true);
window.addEventListener("resize",report);
if(window.ResizeObserver){
  new ResizeObserver(report).observe(document.documentElement);
  if(document.body)new ResizeObserver(report).observe(document.body)
}
report()
})()</script>`
}
