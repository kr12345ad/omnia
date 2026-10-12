# Computer tool layer — agent-facing boundaries

This folder is the model-facing surface of computer use. The reliability rules themselves live in
`packages/omnia/src/computer-use/RELIABILITY.md` and the program contract is
`docs/computer-use-reliability.md`. Read both before changing anything here.

This layer **represents** desktop state and **refuses** bad requests. It does not own the matching
threshold, the aim strategies, or the verification verdict — it imports them. Re-implementing any of them
here is the way the old failure modes come back.

## Invariants

1. **One match threshold, imported.** `MATCH_THRESHOLD` and `scoreMatch` come from
   `@opencode-ai/omnia/computer-use/match-score`. Never write a local score, a local floor, or a local
   `includes` heuristic. Below the floor is a refusal with the reason printed, not a ranked candidate:
   `find.ts:171`, `read.ts:173`, `act.ts:428`, `browser.ts:559`.
2. **One aim implementation, imported.** `computeAim` and `isCenterGuess` come from
   `@opencode-ai/omnia/computer-use/aim`. Never compute a click point from bounds here.
   `observe.ts:180` is the only place in this folder that chooses a strategy, and it labels
   `bounds-center` as a guess rather than a precise point. A `bounds-center` result must always be
   surfaced as a guess to the model: `snapshot.ts:170` (`center-guess` warning), `find.ts:107`,
   `read.ts:215`, `inspect.ts:234`, `act.ts:746`.
3. **Never claim what was not observed.** Status strings come from the server's verification record.
   `not_verified` is a valid, expected outcome and must be printed as-is; do not paraphrase it into
   success, and do not re-run the action to try to get a better answer.
4. **A ref is bound to its observation.** A ref handed out carries the observation it was read from.
   A tree answered for a different computer is refused, not handed over
   (`find.ts:145-160`, error code `identity_not_for_this_computer`).
5. **Pixel coordinates are for canvas/unknown surfaces only.** Never pass a pixel where a resolvable
   ref exists.

## Files

| File | Owns |
|---|---|
| `snapshot.ts` | the screen payload: refs, generation, `diff` mode, the `center-guess` warning (`snapshot.ts:170`) |
| `observe.ts` | the compact observation, and the tool layer's only aim-strategy choice (`observe.ts:180`) |
| `find.ts` | semantic query → refs at the shared floor, plus foreign-observation refusal (`find.ts:171`) |
| `read.ts` | reading a control/surface at the shared floor (`read.ts:173`) |
| `inspect.ts` | one control in full, including its aim and whether that aim is a guess (`inspect.ts:234`) |
| `act.ts` / `do.ts` | dispatching actions; the `bounds-center` warning (`act.ts:746`) |
| `actions.ts` | the action vocabularies (`UI_ACTIONS`, `BROWSER_ACTIONS`, `PLAN_ACTIONS`) — data only |
| `browser.ts` | the browser surface; same floor and same guess rules (`browser.ts:559`, `browser.ts:601`) |
| `visual.ts` | vision grounding — pixel points, by design |
| `*.txt` | the tool descriptions the model reads. These are the agent-facing contract; change them in the same commit as a behaviour change |

## Current gaps

- **No tool-level assertion pins the imported rules.** `reliability-e2e.test.ts` in
  `packages/omnia/src/computer-use/` covers the stack end to end but drives the service, not these tools.
  A local threshold or a locally computed aim point would not fail any test here.
- **`act.ts` still forwards a caller-supplied pixel** when the caller declares a surface. That is the
  sanctioned pixel path, but it is the same arithmetic the P0 came from.
- **The `.txt` descriptions are prose and can drift** from the code they describe. Nothing checks them.
