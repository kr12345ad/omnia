# Computer-Use Reliability Program — build contract

Goal: agents must land actions reliably and only report what actually happened.
Symptom being fixed (documented in `FOCUS_ROLLOUT.strategist.md`): semantic
query over-match (0.4 `query.includes(name)`) feeds a blind bounds-center click,
which clicked Close instead of Minimize (9px apart) and then reported
"Verified".

## Non-negotiable rules for every change

1. **Never claim success without evidence.** A result is `verified` only when a
   post-action observation confirms it (e.g. `activeWindow` contains the target
   title). Otherwise it is `not_verified` with the observed state attached.
2. **Never click the center of a bounding box as a default.** Choose an
   actionable point from element metadata (control center, focus point,
   role-specific inset). Center-of-bounds is the last resort only for
   element kinds with no better hint, and must be recorded as `aim: "bounds-center"`.
3. **Match scores must be honest.** Remove the 0.4 `query.includes(name)`
   branch. `name.includes(query)` floors at 0.6; exact adds 0.25. Below 0.6 is
   no match. Router and provider must agree on one threshold.
4. **Refs are the primary targeting mode.** A `ref` + `observationId` from a
   recent snapshot beats a semantic query. Refs are generation-scoped; stale
   refs are refused, never silently rebound.
5. **Miss beats wrong-click.** When confidence is low, return a clarification or
   fall back to vision grounding — never a guess.
6. **Pixel coordinates are for canvas/unknown surfaces only**, never as a
   substitute for a resolvable control.

## File ownership (do not edit outside your assigned area)

| Area | Owns |
|---|---|
| `matching` | `packages/omnia/src/computer-use/providers.ts`, `packages/omnia/src/computer-use/router.ts` |
| `focus` | `packages/omnia/src/computer-use/service.ts` (window-management + verification), `resolveWindowFocus` in `computers.ts` |
| `repr` | `packages/opencode/src/tool/computer/{snapshot,observe,read,find,inspect,output}.ts` + matching `.txt` |
| `aim` | `packages/opencode/src/tool/computer/{act,do,policy,actions}.ts`, `packages/omnia/src/computer-use/window-safety.ts` |
| `harness` | `packages/omnia/src/computer-use/live-harness/**` (new) |
| `cua` | `packages/omnia/src/cua/**` |
| `desktop` | `packages/app/src/**`, `packages/desktop/src/main/omnia/**` |
| `browser` | `packages/opencode/src/tool/computer/browser.ts` |

## Interface contract — the screen payload (already the shape of `computer_snapshot`)

```json
{
  "observationId": "obs_...",
  "generation": 42,
  "accessibility": "available | degraded | unavailable",
  "windows": [{ "id": "win_...", "application": "kitty", "title": "OC | Quick hello",
                "focused": true, "bounds": {"x":0,"y":0,"width":1920,"height":1080} }],
  "elements": [{
    "ref": "cua:window/kitty/OC | Quick hello/3/textfield/Command/1",
    "role": "textfield", "name": "Command", "text": "...", "value": "...",
    "states": ["focused","enabled"], "actions": ["focus","set_value"],
    "bounds": {"x":10,"y":40,"width":800,"height":24},
    "aim": {"x":410,"y":52,"strategy":"control-center"},
    "application": "kitty", "windowRef": "win_...", "parentRef": "..."
  }],
  "truncated": false,
  "warnings": []
}
```

Rules for the payload: `aim` is always present for actionable elements;
`strategy` is one of `control-center | focus-point | role-inset | provider-hint
| bounds-center`; `bounds-center` always sets a warning.

## Definition of done for the program

1. No code path can click without either a resolved ref or an explicit
   `aim.strategy` other than `bounds-center` on a named control.
2. No result claims `verified` without a confirming observation.
3. A live harness (`live-harness`) runs N trials against a real desktop and
   fails on wrong-target clicks, false verification, and stale refs.
4. `bun test` green in `packages/omnia` + `packages/opencode`, `tsgo --noEmit`
   green in both, and the harness reports a pass rate.
