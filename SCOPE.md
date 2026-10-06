# SCOPE.md — UI Inconsistency & Bug Audit

**Status:** active decision record · **Owner:** strategist · **Date:** 2026-09-26
**Room decision:** audit and fix the shared product UI spine only; every fix needs file:line evidence and a same-command verification step; console, docs, web, tui and storybook config are out of fix scope.

## 1. Claim boundary

"Fix all UI inconsistencies and bugs" is unbounded. Operationally this audit completes when every in-scope surface has passed the two-pass procedure in §6 within budget and every P0/P1 found has a verified fix or a logged accepted risk. It does **not** claim the UI contains no bugs; it claims **no P0/P1 remaining within the audited scope**. P2 findings are logged in the decision log, never fixed here.

## 2. Why this spine: shared-component evidence

`packages/ui` (primitives, theme tokens, i18n, stories) ← `packages/session-ui` ← `packages/app` ← `packages/desktop` (wrapper). A single `ui` fix reaches 143 app files; console touches `ui` in only 3 files and is a separate product.

Reproduce (all commands from repo root; counts 2026-09-26):

```bash
grep -rl "@opencode-ai/ui" packages/app/src | wc -l             # 143
grep -rl "@opencode-ai/session-ui" packages/app/src | wc -l      # 33
grep -rl "@opencode-ai/ui/v2" packages/app/src | wc -l           # 58
grep -rl "@opencode-ai/ui" packages/session-ui/src | wc -l       # 38
grep -rl "@opencode-ai/app" packages/desktop/src | wc -l         # 11
grep -rl "@opencode-ai/ui" packages/console/app/src | wc -l      # 3
find packages/ui/src -name '*.tsx' | wc -l                        # 157 (87 components + 57 v2)
find packages/session-ui/src -name '*.tsx' | wc -l                # 53 (36 components + 16 v2)
find packages/app/src -name '*.tsx' | wc -l                       # 157
find packages/desktop/src -name '*.tsx' | wc -l                   # 2 (renderer/index, onboarding)
find packages/ui/src -name '*.stories.tsx' | wc -l                # 68
find packages/session-ui/src -name '*.stories.tsx' | wc -l        # 16
find packages/ui/src/theme/themes -name '*.json' | wc -l          # 37
find packages/app/src packages/app/test-browser -name '*.test.ts*' | wc -l  # 119
find packages/ui/src -name '*.test.ts*' | wc -l                   # 4
find packages/session-ui/src -name '*.test.ts*' | wc -l           # 14
```

## 3. In scope

| ID | Surface | Paths | Why in scope | Verification |
|----|---------|-------|--------------|--------------|
| S1 | UI primitives | `packages/ui/src/{components,v2,theme,styles,hooks,i18n}` | Root of the shared spine; tokens and 68 stories define expected appearance | `cd packages/ui && bun typecheck && bun test`; storybook visual |
| S2 | Session UI | `packages/session-ui/src/{components,v2}` | Session surface used by 33 app files; 16 stories | `cd packages/session-ui && bun typecheck && bun test`; storybook visual; app integration |
| S3 | App | `packages/app/src` | Primary shipped UI; consumes both libraries | `cd packages/app && bun typecheck && bun test`; `bun dev:web` visual; optional `bun test:e2e` |
| S4 | Desktop chrome | `packages/desktop/src/renderer`, plus UI-adjacent `main` (menu, windows, onboarding, i18n) and `preload` | Electron window chrome, menus and onboarding are user-visible; 11 files import app | `cd packages/desktop && bun typecheck`; `bun dev:desktop` manual; test runner TBD (§8) |
| V0 | Storybook | `packages/storybook` | Verification harness only — not fixed | `bun dev:storybook` (port 6006) |

Cross-cutting checks inside S1–S4: v1/v2 component consumer overlap, token usage across 37 themes, locale key parity (app/ui/desktop), loading/empty/error states, focus/keyboard on interactive primitives, platform-branch intentionality.

## 4. Out of scope — not-fixed list

- `packages/console/*` — separate product; only 3 files import `@opencode-ai/ui`; revisit **only** if a shared-component defect reproduces there.
- `packages/docs` (13 `.mdx`, 0 `.tsx`), `packages/web` (Astro site), `packages/tui` (102 `.tsx`, separate renderer), `packages/stats`, `packages/storybook` config.
- Non-UI packages: `core`, `server`, `client`, `protocol`, `opencode`, `sdk*`, generated code.
- Non-goals: redesigns, new features (CONTRIBUTING.md requires design review), a11y overhaul, i18n content, dependency upgrades, v1→v2 migration, broad refactors, intentional platform variance, P2 polish, upstream PRs (issue-first policy).

## 5. Severity and intentionality

- **P0** — crash/hang/data loss/blocked core flow (cannot send prompt or open session) or unreadable text in a supported theme.
- **P1** — shipped-surface divergence: wrong/missing token or color, missing loading/empty/error state, broken layout at a supported viewport, overlapping v1/v2 consumers disagreeing, missing/misused i18n key, keyboard/focus defect.
- **P2** — cosmetic/polish only → decision log; not fixed.

A divergence is **not** a defect if (a) a platform branch explains it, (b) it is token/theme-driven by design, or (c) a story documents it. A raw literal where a token exists, with no branch, is a candidate; the critic adjudicates.

## 6. Two-pass stop rule per surface (strategist-owned)

For each of S1–S4 independently:

1. **Pass A — mechanical.** Run the surface's verification commands; scan for hardcoded colors/px where tokens exist, v1/v2 consumer overlap, i18n key differences, missing loading/empty/error states, focus/keyboard gaps on interactive primitives.
2. **Pass B — targeted.** Rank components by usage (app imports, story coverage); inspect the top set against theme tokens and stories in light/dark; review platform branches.

**Halt rule:** a surface halts after **two consecutive complete passes yield zero new P0/P1 candidates**. A finding after a halt opens a new audit ticket — it does not reopen this one.
**Budget cap:** 15 fixed issues or 2 calendar days per surface, whichever comes first; then halt.
**Global stop:** all four surfaces halted or capped → publish the residual/P2/out-of-scope list. Never report "UI has no bugs".
**Evidence rule:** every pass records its tree state (HEAD + dirty count) and commands; findings without file:line are unverified and cannot be fixed.

## 7. Verification contract per fix

1. Defect statement: file:line, expected vs actual, repro.
2. Intentionality check against §5 recorded (branch/token/story).
3. Same-command before/after with exit codes (commands in §3), run from the package directory (`AGENTS.md`: never `tsc`; tests never from repo root).
4. Touched package: `bun typecheck` + `bun test` pass; root `bun lint` shows no new failures vs the recorded baseline (baseline already fails).
5. Regression guard: a test or story is added; otherwise an accepted risk is logged in the decision log.
6. Commit: `fix(<scope>): summary` per AGENTS.md; small diffs only; no drive-by changes.

## 8. Baseline, gaps, change control

- **Reference pin:** `baseline-pin-2609` @ `d0773bd` (stash snapshot on `dev` @ `a4b15ee5ac`; 78 tracked modifications).
- **Known gaps (researcher owns re-pin):** 71 untracked files are not in the pin; the live tree has diverged from the pin (`git switch baseline-pin-2609` refused — local changes would be overwritten) and was still changing during this audit (78 → 79 modified files). Fixes must name the tree state they were verified against.
- **Lint baseline:** pre-existing failures; the bar is "no new failures" (exact failing locations owned by the builder).
- This file changes only by commit with a stated reason. In/out scope changes require a room decision.
