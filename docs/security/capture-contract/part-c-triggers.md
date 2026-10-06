# Part C — Classification Authority + M3a/M3b Resequence Trigger Table

**Subject:** Week-1 capture-contract spike (6 pass/fail items) → M3 decision gate.
**Version:** 1.0. Operationalizes the adopted decision rules; changes none of them.
**Decision lock:** Friday of Week 1 (W1), 18:00 — every developer knows their path at this time.
**M3 build start:** Monday W2. "M3 week 2" = W3. All adjudication closes Thursday W2 12:00, i.e. M3 week 2 is never entered with an open adjudication.

## 0. Terms and clock

| Term | Definition |
|---|---|
| W1 / W2 / W3 | W1 = spike week. W2 = first M3 build week. W3 = M3 week 2. |
| POR | Plan of record if all six PASS: M3a W2–W7 (6w) → M3b W8–W13 (6w) → Self-Healing + Packs W14–W21 (8w) → Fleet W22–W31 (10w); Copilot at its pre-spike slot. |
| PPP | Partial-pass plan (items 1–3 PASS, 4–5 FAIL, 6 PASS): M3a W2–W7 → M3b W8–W13; Copilot pulled ahead Δ−6w; Self-Healing + Packs 8w; Fleet 10w. |
| trust-class | Items 2 and 3. A leak is a hard stop: M3 stopped entirely; Copilot resequenced above skills. |
| coverage-class | Items 1, 4, 5. Narrow scope + ONE re-spike; two failures = cut P3/P4. |
| boundary-class | Item 6. Freeze + 24 business hours to remediate; escalates to trust-class if unresolved or if a secret-bearing surface was reached. |
| Evidence states | **PASS** = artifact attached, threshold met. **FAIL** = artifact attached, threshold missed. **UNVERIFIED** = artifact absent, stale, or produced by an inadmissible producer. UNVERIFIED is never PASS. |

Roles (authority is always a role, never a person): **feature owner** (capture contract), **security owner**, **architecture owner**, **manager** (program/eng manager), **capture engineer** (feature team), **replay engineer / QA**, **serializer owner**, **platform owners** (Linux AT-SPI; macOS AX / Windows UIA), **independent verifier** (did not author the artifact).

Deadlines are business hours from publication of the item's artifact in the spike report, or absolute times where stated. Thresholds are verbatim from the spike contract and are not negotiable at adjudication time.

---

## 1. Failure taxonomy

| # | Item — threshold | Class | Required evidence artifact | Producer | Independent verification | Failure declarer / decision authority | Response deadline |
|---|---|---|---|---|---|---|---|
| 1 | **Coverage** — 20-action task in 2 apps, zero unclassified events, ≥90% typed steps `{verb, anchor, value-class, risk}` | coverage | `capture-ledger`: raw event stream for the 20 actions + typed-step table showing per-step `{verb, anchor, value-class, risk}` and the unclassified count. `risk` uses the level vocabulary of the danger classifier (`none|low|medium|high|critical`). All artifacts SHA-256 hashed. | capture engineer (feature team) | QA re-derives the ratio from the raw ledger and audits all 20 typed steps | feature owner declares; manager adjudicates contentions only | declare ≤4h; absolute cutoff **Fri W1 12:00** |
| 2 | **Cross-platform** — identical schema from Linux AT-SPI plus AX or UIA via one serializer | trust | `canonical-schema-proof`: same task replayed on both platforms; canonicalized schema hash equality + empty field-level diff + serializer revision id | platform owners + serializer owner | architecture owner recomputes the canonical hash independently | security owner (final call), jointly declared with architecture owner | declare ≤4h; **hard stop immediate**, no in-week remediation |
| 3 | **Redaction** — zero secret bytes in captured draft; SECRETS / CLIPBOARD_READ excluded by default | trust | `redaction-scan`: (a) canary suite result — planted secrets incl. a SECRETS and a clipboard payload, zero occurrences in draft; (b) byte scan of the draft hash; (c) ledger-absence proof that SECRETS/CLIPBOARD_READ were never emitted into capture | security engineer; **never the feature owner alone** | security owner signs; canary fixtures held only by security owner | security owner (veto) | notify ≤1h; declare ≤4h; contain (flag off, draft quarantined) ≤24h |
| 4 | **Replayability** — ≥8/10 steps via semantic anchors on 3 unchanged apps | coverage | `replay-run`: per-step resolution table; coordinate fallback does not count as resolved | replay engineer | independent verifier replays 3 sampled steps and re-derives the 8/10 count | feature owner | declare ≤4h; absolute cutoff **Fri W1 12:00** |
| 5 | **Stability** — two captures of the same task diff ≤20% | coverage | `stability-diff`: both raw captures hashed, diff tool name + version recorded; normalized step-structure diff ≤20% | capture engineer | independent verifier re-runs the diff binary on the raw artifacts | feature owner | declare ≤4h; absolute cutoff **Fri W1 12:00** |
| 6 | **Boundary** — capture consumes server event bus only; no direct driver hooks | boundary | `boundary-proof`: (a) static import graph showing no driver imports; (b) runtime provenance trace — every captured event carries a bus origin/sequence id, `count(captured) == count(bus-emitted filtered)`, no gaps | architecture owner | security engineer verifies the runtime trace on a clean checkout | architecture owner declares; security owner may escalate to trust-class | declare ≤4h; **freeze immediate**; remediate ≤24 business hours |

**Threshold rulings (fixed, no interpretation at adjudication):**
- Item 1: exactly 20 actions, exactly 2 apps, unclassified count = 0, typed ratio ≥ 0.90. `unknown`/missing `risk` counts as unclassified.
- Item 2: any field-level divergence or hash inequality is a FAIL; a recorder that fails to attach (harness failure) is UNVERIFIED, not FAIL — see §3.3.
- Item 3: one canary byte in the draft is a FAIL; exclusion must be proven by absence in the ledger, not by a downstream filter.
- Item 4: 8/10 or better; anchor match only; coordinate fallback steps are not counted as resolved.
- Item 5: ≤20.0% passes; 20.1% fails. Tool/version changes invalidate the run (re-capture required; if impossible by Fri W1 12:00, R6 applies).
- Item 6: one untraced captured event is a FAIL.

---

## 2. Trigger table

One row must be selected and signed at Friday W1 18:00. Precedence when multiple rows seem to apply: **trust (R3/R4) > boundary unresolved (R5→R3) > coverage (R2 > R1b > R1) > R0.**

| Row | Observed outcome (items 1–6) | Class | Action | Milestone changes (exact; Δ vs POR) | Sign-off authority | Re-entry conditions for anything cut |
|---|---|---|---|---|---|---|
| **R0** | All six PASS | none | Proceed at full scope | M3a W2–W7 (6w), M3b W8–W13 (6w), Self-Healing + Packs W14–W21 (8w), Fleet W22–W31 (10w); Copilot at base slot. **Δ0 everywhere.** | manager + feature owner + security owner + architecture owner | n/a |
| **R1** | Exactly one of items 1/4/5 FAIL; items 2/3/6 PASS; other coverage items PASS | coverage | Narrow scope per card 2.1 + **ONE** re-spike (Mon–Wed W2) | M3a starts **W3 (Δ+5 business days / +1w)**; M3b and everything downstream **+1w**. Compression allowed only if re-spike PASS is adjudicated by Wed W2 18:00: M3a may start **Thu W2 (Δ+3bd)** with a written note. **Re-spike FAIL ⇒ R2.** | feature owner (narrow card) + manager (week slip) | Return to full scope when the original full-scope artifact PASSes: feature owner + manager sign; no further date change. This is the only re-spike; a second one is not permitted. |
| **R1b** | Items 1–3 PASS, items 4–5 FAIL, item 6 PASS (partial pass) | coverage | No re-spike; split M3 into M3a → M3b per the adopted partial-pass rule | **PPP:** M3a W2–W7 (Δ0), M3b W8–W13 (Δ0; M3 total 12w unchanged); Copilot pulled ahead **Δ−6w**, above Self-Healing + Packs and Fleet; Self-Healing + Packs 8w, Fleet 10w. Non-M3 start dates are pinned in the decision record at sign-off. | manager + security owner (acknowledges trust items green) + feature owner | None for M3 (M3b is in plan). Descoped item-4/5 features may be re-widened later under the R1 re-entry rule. |
| **R2** | Any second coverage-class failure: two distinct coverage items FAIL at any point, or an R1 re-spike FAILs (or its adjudication is unresolved at Thu W2 12:00); items 2/3/6 PASS | coverage | Cut P3 (Teach-by-Demonstration) and P4 (Self-Healing); promote Fleet to **#3** and Copilot to **#4** | M3a/M3b **canceled, no dates**; P3 and P4 removed from the quarter; **Fleet #5→#3, starts W2 (10w, W2–W11, Δ−20w)**; **Copilot #4, starts W12**; capture flag stays default-off; spike code archived behind the flag | manager (mandatory) + security owner ack + feature owner (archival) | **P3:** a fresh full 6-item capture-contract spike PASSes; manager + security owner sign; earliest re-entry is the next planning cycle, never inside the committed quarter. **P4:** requires P3 re-entered first and anchor coverage ≥90% over a ≥50-step task; separate gate. |
| **R3** | Item 3 FAIL (any other items irrelevant) | trust | **Trust-class hard stop.** M3 stopped entirely. Resequence Copilot above skills. Containment: capture flags default-off; draft quarantined (secured copy in restricted store, original deleted); any real secret found ⇒ rotate per security owner | M3a/M3b **canceled**; no M3 dates; **Copilot promoted above all skills, priority #3, starts W2 (Δ ≤ −6w)**; Self-Healing + Packs and Fleet stay behind Copilot, dates re-pinned by manager at sign-off | security owner (verdict/veto) + manager (resequence) | New spike with all six PASS including canary suite + ledger-absence proof; security owner signs; secrets rotated if applicable; no re-entry date promised by this row. |
| **R4** | Item 2 FAIL (any other items irrelevant; product divergence or cross-platform data leak) | trust | Same as R3, plus serializer workstream frozen at its last known-good revision | Same as R3 | security owner + manager | Same as R3, plus canonical-hash equality on both platforms and security owner sign. **Downgrade path:** if the divergence is proven cosmetic with a lossless mapping and zero secret/type leakage across platforms, security owner + manager may jointly reclassify to coverage → R1 card (serializer narrowed to the failing platform pair). Default classification remains trust (R4). |
| **R5** | Item 6 FAIL | boundary | Contract-integrity freeze: M3 build start held; fix the boundary, then re-test. **No milestone changes until re-test.** | If re-test PASS by Wed W2: M3a starts **Thu W2 (Δ+3bd)**; M3b and downstream +3bd; boundary check becomes a per-commit CI gate. If FAIL or unresolved by **Thu W2 12:00 ⇒ R3 (trust hard stop).** If the direct hook reached a secret-bearing surface ⇒ **immediate R3**, no remediation window. | architecture owner declares + security owner concurs + manager signs the hold | Two consecutive green boundary proofs on clean checkouts; CI gate retained for the life of M3. |
| **R6** | Any item UNVERIFIED or class ambiguous at Fri W1 18:00 | maps by item (below) | Conservative default — never PASS | Item 2/3 UNVERIFIED ⇒ treat as trust FAIL: one re-production window of ≤24 business hours from frozen W1 artifacts only; M3a start held; re-adjudication Thu W2 12:00; still UNVERIFIED ⇒ **R3 effective retroactive to Fri W1**. Items 1/4/5 UNVERIFIED ⇒ counts as a coverage FAIL toward R1/R2 (an UNVERIFIED second coverage item = R2 at lock). Item 6 UNVERIFIED ⇒ R5 freeze. Ambiguous class ⇒ trust until a written finding. | manager + security owner (trust items); manager (coverage items) | Same as the mapped row. |
| **Any trust observation in the report overrides everything** — coverage handling for that week is void (coverage failures are still recorded) | — | trust | **R3/R4 governs** | R3/R4 milestone changes | security owner + manager | R3/R4 re-entry |

### 2.1 Narrow-scope cards (R1 only — fixed, published with the Friday report)

| Failing item | Narrowed re-spike scope (Mon–Wed W2) | Pass bar |
|---|---|---|
| 1 | 10-action task, 1 app (the passing one), same capture pipeline | zero unclassified, ≥90% typed `{verb, anchor, value-class, risk}` |
| 4 | 5 steps, 1 app | ≥4/5 via semantic anchors, zero coordinate fallbacks counted |
| 5 | 10-action single-session task, two fresh captures, same diff tool version | diff ≤20.0% |

No widening of a card mid-re-spike. The card is the deliverable of R1; scope returns only through the R1 re-entry rule.

### 2.2 What the developer is told Friday 18:00 (one line, no other state)

- **R0:** "Full scope, M3a starts Monday W2."
- **R1:** "Narrowed card published, re-spike Mon–Wed W2, M3a starts Monday W3 at latest."
- **R1b:** "Split plan, M3a starts Monday W2; Copilot pulled ahead 6 weeks."
- **R2:** "M3/P3/P4 cut; new assignment is Fleet (#3); Copilot is #4."
- **R3/R4:** "Hard stop on capture; new assignment is Copilot above skills."
- **R5:** "Build start held; boundary re-test Wednesday W2; resumption Thursday W2 if green."
- **R6:** "Evidence incomplete; conservative path `<mapped row>` is in force until Thu W2 12:00."

---

## 3. Classification authority rules

**3.1 Who classifies.**

| Domain | Classifier | Can be contested by | Final adjudicator |
|---|---|---|---|
| Item 1, 4, 5 (coverage) | feature owner | QA / independent verifier | manager — may change PASS/FAIL of the coverage item but **cannot change its class** |
| Item 2 (trust, with architecture input) | security owner, jointly declared with architecture owner | architecture owner | security owner (final) |
| Item 3 (trust) | security owner | nobody within the spike | security owner (veto) |
| Item 6 (boundary) | architecture owner | security engineer | security owner for escalation to trust; otherwise architecture owner + manager |
| Schedule / milestone response | manager | — | manager owns the row's schedule action; cannot alter the class verdict |

**3.2 Disputes between coverage and trust class — trust wins.**
- A claimant files a one-paragraph finding with artifact hashes within 4 business hours of the disputed classification.
- The security owner rules within 4 hours. A trust ruling is effective immediately: capture flags off, M3 work stops, R3/R4 applies.
- Downgrading a trust ruling to coverage requires a **written joint finding signed by the security owner and the manager** stating (a) no secret bytes and no excluded event type (SECRETS / CLIPBOARD_READ) crossed into the draft, and (b) the defect is a bounded functional gap, named artifacts/branches only. The downgrade is logged in the decision record. **A second downgrade in the same spike is prohibited** — it automatically reverts to trust.
- The manager may not reclassify to avoid the hard stop. The manager may only narrow scope while the hard stop remains in force.

**3.3 Missing or ambiguous evidence — default to the more conservative class.**
- No artifact = not PASS. UNVERIFIED never counts as green and can never produce an "all pass" record.
- Ambiguity between coverage and trust nature ⇒ trust-class until a written security-owner finding says otherwise.
- Ambiguity between PASS and FAIL ⇒ FAIL.
- Evidence for items 2, 3, 6 produced solely by the feature owner is inadmissible. A 24-business-hour re-production window applies from frozen W1 artifacts only, ending Thu W2 12:00; after that the conservative outcome stands (R3 for items 2/3; R5 for item 6).
- A harness/tooling failure is UNVERIFIED, not FAIL, but follows the same conservative clock: if it cannot be re-run to a verdict by Thu W2 12:00 it converts to FAIL of that item.

**3.4 Separation of duties.** Producer ≠ verifier ≠ adjudicator for items 2, 3, 6. Coverage artifacts may come from the feature team but the numbers (ratio, replay count, diff %) must be re-derived by an independent verifier from the raw artifacts, or the item is UNVERIFIED.

**3.5 Ordering of decisions.** Class verdict first, then milestone action. A schedule action signed before the class verdict is invalid and the record is reopened under R6.

**3.6 Friday lock.** At Fri W1 18:00 exactly one trigger row is selected and signed. No "TBD" rows. Any open item forces its conservative row (R6 mapping). Adjudication fully closes by Thu W2 12:00; M3 week 2 (W3) is never entered with an open adjudication — an unresolved R1 re-spike becomes R2 and an unresolved trust re-production becomes R3.

---

## 4. Decision record template (append to the spike report)

```
capture-contract decision record
record_id:            CC-W1-<yyyymmdd>-<seq>
decision_timestamp:   <Fri W1, 18:00 | other + reason>
spike_run_id:         <run id>
commit_shas:          capture=<sha> serializer=<sha> harness=<sha>
tool_versions:        capture=<v> diff=<v> canary=<v>

item results
| # | threshold | measured | state (PASS/FAIL/UNVERIFIED) | class (trust/coverage/boundary) | artifact (path + sha256) | producer | verifier |
| 1 | ...       | ...      | ...                          | ...                             | ...                     | ...      | ...      |
| 2 | ...       | ...      | ...                          | ...                             | ...                     | ...      | ...      |
| 3 | ...       | ...      | ...                          | ...                             | ...                     | ...      | ...      |
| 4 | ...       | ...      | ...                          | ...                             | ...                     | ...      | ...      |
| 5 | ...       | ...      | ...                          | ...                             | ...                     | ...      | ...      |
| 6 | ...       | ...      | ...                          | ...                             | ...                     | ...      | ...      |

classification rulings
- rulings:                 <item -> class, who ruled, timestamp>
- contested:               <finding + resolution, or none>
- downgrades:              <joint finding reference, or none (max one per spike)>

trigger row selected:       R0 | R1 | R1b | R2 | R3 | R4 | R5 | R6
precedence applied:         <e.g. trust over coverage>
rationale:                  <2-4 sentences, cites artifacts only>

milestone actions
| milestone | from (POR/PPP/prior) | to | delta (w or business days) | absolute window |
| ...       | ...                  | ...| ...                         | ...             |

narrowed scope cards:       <R1 only: card id + contents, or n/a>
cut list + re-entry:        <R2/R3/R4 only: feature, re-entry gate, owner>
containment/quarantine:     <R3/R4/R5 only: flags off, draft hash, copy location, rotations>

sign-offs (required by row; timestamp each)
- manager:           <name/role, verdict signed>
- security owner:    <name/role, verdict signed>
- feature owner:     <name/role, verdict signed>
- architecture owner:<name/role, verdict signed>

open items (decision-blocking items must be empty at lock)
| item | owner | deadline | conservative default if missed |

distribution + announcement: <list> / <one-line path statement from 2.2>
```

**Record rules:** artifact hashes are mandatory for every PASS/FAIL; a row with an unsigned required sign-off is not in force and the conservative default applies until it is signed; the record is immutable after lock except by appending an adjudication addendum (new timestamp + both trust and manager signatures).

---

## Appendix A — Friday W1 checklist (in order)

1. Publish all six artifacts with hashes; mark each PASS / FAIL / UNVERIFIED.
2. Assign the class per §1; resolve any coverage-vs-trust dispute per §3.2 (trust wins).
3. Map UNVERIFIED items per R6 before selecting a row.
4. Apply combination precedence (§2) and select exactly one row.
5. Apply that row's milestone deltas verbatim; pin any non-M3 start date the row leaves unstated.
6. Sign per row; announce the one-line path statement (2.2).
7. Lock the record at 18:00. Reopen only by addendum before Thu W2 12:00.
