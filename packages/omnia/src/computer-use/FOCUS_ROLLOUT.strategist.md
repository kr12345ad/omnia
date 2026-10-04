# Focus-fix rollout (strategist) — Kitty `OC | Quick hello` (960,539) bug

## Failure
`computer_visual` click "focus the Kitty terminal window titled OC | Quick hello"
→ semantic 40% → click (960,539) screen-center ×2 (1st falsely Verified, 2nd Not verified).
Window never focused. P0 title-bar ban uninvolved.

## Root cause (verified in code)
- `providers.ts:1082 bestMatch`: `query.includes(name) && name.length>2 ? 0.4 : 0`, any `score>0` wins → over-match.
  Live repro: query contains `OC | Quick hello` (or generic `window`/`terminal`) → 0.4 winner.
  Wrong full-screen/root element (bounds 0,0,1920x1080) → center (960,540≈539) via
  `actionForOperation:1102` blind `bounds center` click.
- `router.ts:427 bestScore` same 0.4 rule but `semanticSufficient:306-315` requires `>=0.5`
  → provider succeeds at 0.4, router rejects → mismatch, falls to vision/semantic unpredictably.
- `service.ts:427 windowManagementFallback`: minimize skips semantic (correct), focus still
  tries `semantic.analyze` click first (`:461`) → wrong-element center-click path.
- `computers.ts:2417 resolveWindowFocus` already resolves `focus_window` by title fragment
  (case-insensitive `name.includes||application.includes`, prefers focused) → 404 `window_not_found`
  when absent. This path works and is unused by focus intents today.
- Verification: `service.ts:649 isVerified` trusts provider `verified` flag, no `activeWindow==target`
  check → false-Verified.

## Rollout order (minimal safe)
### Phase 0 — Gate (researcher, blocks Phase 2 fallback)
Prove `focus_window("OC | Quick hello")` live on KDE X11 1920x1080: log `activeWindow` before/after,
return `resolveWindowFocus` target id. If title fails, primary becomes `activate_app(kitty)`.
Do not finalize fallback until log exists.

### Phase 1 — Match-fix first (stop the bleed)
- `providers.ts bestMatch`: delete 0.4 `query.includes(name)` branch; floor `name.includes(query)→0.6`,
  exact `+0.25`; reject `<0.6` (return undefined).
- `router.ts bestScore` + `semanticSufficient`: align to `>=0.6`; remove 0.4 branch.
- Focus intents additionally require title-token overlap (≥1 non-stopword from `extractTitle`)
  else no semantic hit. No focus bypass — focus intents never use semantic click.
- Why first: eliminates false-Verified center-clicks even if routing lags; slows vague queries
  to vision/clarify (accepted tradeoff: miss > wrong click).

### Phase 2 — focus_window routing second (correctness)
- New `isWindowFocusIntent(op, target, task)`: `op==click|ground` AND
  `/(focus|activate\s+window|bring\s+.*front|switch\s+to|raise)/i` AND `/window|terminal|kitty/i`
  AND `extractTitle` non-empty AND negative guard (no `link|button|tab|field|text|menu|icon inside|click.*in (the )?kitty`).
  "focus kitty OC|Quick hello" routes; "click link in Kitty" stays on click.
- `extractTitle`: quoted-first (`"..."`), else split on `|`/`—`/`–`, keep full + longest fragment,
  case-insensitive. `OC | Quick hello` → try full, fallback `Quick hello`, `OC`.
- `service.ts windowManagementFallback`: titled focus intents bypass `semantic.analyze` entirely;
  emit `focus_window` action `{type:"focus_window", window:title}` (handled by `computers.ts:2460`).
  Fallback order: `focus_window(full title)` → `activate_app(kitty)` → vision-ground window body
  (P0-safe, no title-strip) → fail loudly. Never semantic center-click, never screen-center.

### Phase 3 — Harness third (lock it)
Extend 20/20 harness (currently missing — no harness file, no `activeWindow` assert):
- Focus trial: after action, `activeWindow` substring (case-insensitive) must match title else FAIL.
- Wrong-target guard: if target names off-center window (>150px from 960,540) and clicked point
  within ±25px of (960,539/540) → FAIL.
- Verification rule: no focus claim `Verified` without `activeWindow==target`; else `Not verified`.

## Done criteria (all must hold)
1. Kitty `OC | Quick hello` focuses live via title (`activeWindow` substring match logged).
2. 0 center-clicks on named-window intents (harness wrong-target guard passes).
3. Focus trial passes only if `activeWindow` matches; center-click ±25px on off-center >150px target = FAIL.
4. `bun test packages/omnia/src/computer-use/computer-use.test.ts` green + `tsgo --noEmit` green.
5. Before/after logs: which element ID/bounds scored 0.4 before, post-fix `focus_window` target id + scores.

## Risks
- 0.6 drops vague-click recall → mitigated by vision fallback.
- KDE `focus_window` title vs app-name quirk → gated by Phase 0 live proof; fallback covers.
- Pipe/case in `OC | Quick hello` → covered by quoted-first extractor.
