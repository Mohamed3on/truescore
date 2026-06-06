# 2. Keep the gmaps chip/search lifecycle inline

Date: 2026-06-06
Status: Accepted

## Context

`gmaps.ts` holds the topic-chip and review-search UI state in six module-level
variables (`activeHighlight`, `activeLabelSearch`, `labelSearchSeq`,
`highlightsState`, `highlightsComputingFor`, `chipViewMode`) — ~52 references
across ~25 functions. An architecture review proposed encapsulating them behind
a `reset(featureId)`-guarded `ChipPanel` module.

After extracting the score cache into `ScoreStore` (a clean seam: storage + clock
injected, a real state machine, 13 tests), the chip/search concern was
re-examined and is different in kind:

- **Its testable cores are already deep.** OR-search parsing/fan-out/dedup lives
  in `gmaps-shared` (`parseOrQuery`, `collectSearchTerms`, `mergeByReviewId`,
  tested in `search.test.ts`); chip impact-ordering and `starString` were lifted
  to `gmaps-shared` in the same review (`sortChipsByImpact`, tested). What is
  left is DOM orchestration.
- **One consumer, no seam.** The state is read/written only by `gmaps.ts`'s own
  DOM handlers. The web client has its own chip/search state, and that
  divergence is intentional (different DOM; see the shared-view-model decision).
  One adapter is a hypothetical seam, not a real one.
- **Deletion test fails.** Moving the six variables into a module would not
  concentrate hidden complexity — the complexity is the DOM wiring, which stays
  in `gmaps.ts` either way. It is a reshuffle, not a deepening, and its failure
  mode is a transient UI glitch, not a wrong score.

## Decision

Leave the chip/search lifecycle inline in `gmaps.ts`. Do not introduce a
`ChipPanel`/`ChipState` module.

## Consequences

- No risk is added to working, hard-to-test chip/search/summary UI for a
  locality-only gain.
- A future architecture review should not re-suggest this extraction unless a
  second consumer of the chip/search state appears (which would create a real
  seam). The deep, shared, tested pieces of this concern already live in
  `gmaps-shared`.
