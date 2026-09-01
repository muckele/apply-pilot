# DOM-Write Spike Evidence Decision

Decision status: **HUMAN APPROVED / FROZEN CANDIDATE MATRIX**

Date: 2026-09-01

Repository baseline: `aa493f0483204d491fb0d10f3787a6edadb08c55`

`DOM_WRITE_SPIKE_STATUS = COMPLETE_AND_HUMAN_APPROVED`

This record freezes the candidate-specific conclusions from the original DOM-write spike and the checkbox truth-table supplement. The evidence authorizes only later implementation under the existing Human-Submit safety architecture. It does not mean a production writer or Increment 3 backend exists.

## 1. Immutable external evidence

The raw artifacts remain external and unchanged. They are not copied into the repository.

### Original DOM-write spike

| Artifact | SHA-256 |
|---|---|
| `environment.json` | `6b745c44ac5a248acc80925d3b252872305b40d0faf5ee8594d2c3d0038f926e` |
| `results.jsonl` | `5cd31034eb80d4bbb6c9c7e452727b7ce40cb18aa54216826b82b20c0ecc112b` |
| `family-verdicts.json` | `bb78efca01777ed3612a9f322ba3b3014e757852e5e2d5c9ee2d039110f115e9` |
| `summary.md` | `05312a57073bc92fce8731ca929f48230472d1f2355238eca9f109364a18cc3e` |

### Checkbox truth-table supplement

| Artifact | SHA-256 |
|---|---|
| `environment.json` | `cc00f9eb5c36a3d2573a9462e1aff6624141e58d136acfd741376ff7b16a7c18` |
| `results.jsonl` | `1bca4a3c3f5d427d48af679f7a4c19a203005af3b71abf0e13a6fb893e13a8b1` |
| `summary.md` | `2813916c85d6e03ca099808fc8de5b6d0e0e597c71ddad8416c1c29fbe6ef2f6` |
| `verdict.json` | `7ed67435c6f51daf257273a7959c689537478ae6c997b2d9bc98ed2c4f4c80cb` |

## 2. Frozen selected matrix

| Control family | Selected production candidate |
|---|---|
| `TEXT` | `NATIVE_VALUE_INPUT` |
| `EMAIL` | `NATIVE_VALUE_INPUT` |
| `TEL` | `NATIVE_VALUE_INPUT` |
| `URL` | `NATIVE_VALUE_INPUT` |
| `TEXTAREA` | `NATIVE_VALUE_INPUT` |
| `SELECT_ONE` | `NATIVE_OPTION_INPUT_CHANGE` |
| `RADIO_GROUP` | `PLAYWRIGHT_CHECK` |
| `CHECKBOX_BOOLEAN` | `PLAYWRIGHT_CHECK` |

This matrix is exhaustive. It authorizes no additional control family or candidate.

## 3. Checkbox truth table

| Current state | Proposal | Classification | Authorized operation |
|---|---|---|---|
| unchecked | true | `EMPTY` | one Playwright checked-to-true operation may be attempted |
| unchecked | false | `ALREADY_EQUAL` | zero writes |
| checked | true | `ALREADY_EQUAL` | zero writes |
| checked | false | `OCCUPIED_DIFFERENT` | zero writes |

`CHECKED_TO_FALSE_NOT_AUTHORIZED`

Production code MUST NOT call `uncheck()` or perform native `checked=false` against a pre-existing checked checkbox. Future checked-to-false automation requires a separate human-reviewed evidence decision.

## 4. Rejected checked candidate

`NATIVE_CHECKED_INPUT_CHANGE` is rejected as the production candidate for both `RADIO_GROUP` and `CHECKBOX_BOOLEAN`. The spike produced deterministic failures including:

- `FRAMEWORK_DOM_DIVERGENCE`;
- `DETACHMENT_NOT_DETECTED`;
- `EVENT_TARGET_MISMATCH`.

These failures are not weakened or reinterpreted by selecting the separate `PLAYWRIGHT_CHECK` candidate.

## 5. Deferred families

The following are not authorized by this evidence:

- `NUMBER`;
- `DATE`;
- `SELECT_MANY`;
- `CHECKBOX_GROUP`;
- `FILE_UPLOAD`;
- `DOCUMENT_REFERENCE upload`;
- custom widgets;
- contenteditable;
- rich text;
- multi-step navigation;
- ATS-specific controls.

## 6. Original summary aggregation caveat

The immutable original `summary.md` contains coarse family-level `FAIL` lines for `RADIO_GROUP` and `CHECKBOX_BOOLEAN`, including same-node, replacement, normalization/rejection, and unrelated-event summaries. Those lines aggregate failures from the rejected native checked candidate at family level; they must not be interpreted as failures of the selected `PLAYWRIGHT_CHECK` candidate.

The authoritative candidate distinction is preserved as follows:

- `family-verdicts.json` selects `PLAYWRIGHT_CHECK` for `RADIO_GROUP` and `CHECKBOX_BOOLEAN`;
- per-record evidence and the execution audit distinguish the passing Playwright candidate from the rejected native candidate;
- this repository decision record is candidate-specific;
- the original immutable summary artifact is not rewritten.

## 7. Production constraints

This evidence does not authorize:

- any submit command, submit scope, `requestSubmit()`, `form.submit()`, Apply Pilot submit-control click, submission inference, or employer submit action;
- retries, a corrective second write, or another automated fill attempt;
- selector or XPath fallback, handle rebinding, or anything other than exact current-generation handles;
- overwriting occupied values or selections;
- exporting raw employer current values beyond page-local evaluation;
- expanding the frozen candidate matrix;
- checked-to-false checkbox automation.

Any later writer must preserve the one automated-fill attempt per run, the permanent `fillAttemptId` fence, bounded owned-mutation windows, safe stops for unrelated applicant activity, generation or detachment loss, and normalization or rejection mismatch, and all no-submit invariants in the main design.

## 8. Relationship to the Human-Submit design

This decision record supplements and is incorporated by [the Human-Submit Fill and Review Design](./2026-08-30-fill-and-review-human-submit-design.md). Increment 1 is complete and frozen at the repository baseline above. Increment 2 evidence is complete and human-approved. Increment 3 and the production fill implementation have not started.

The evidence changes only which later DOM-write candidates may be implemented. It does not create Fill authority, submission authority, a writer, a fill-attempt resource, or runtime behavior.
