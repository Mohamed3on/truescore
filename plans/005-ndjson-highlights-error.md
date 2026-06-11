# Plan 005: Surface NDJSON `error` events in the highlights stream consumer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4a3a843..HEAD -- packages/web/client.ts`
> If `client.ts` changed since this plan was written, compare the "Current state"
> excerpts against the live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `4a3a843`, 2026-06-11

## Why this matters

The web server can emit a terminal `{type:'error'}` event on any NDJSON stream
when its producer throws (`packages/web/server.ts:85`). Every stream consumer in
the client handles that event **except the highlights one**. `consumeHighlightStream`
(`client.ts:610-635`) is a `switch` over `evt.type` with cases for `chips`,
`chip`, `chip-error`, and `done` — but no `error` case and no `default`. So if the
highlights producer throws mid-stream (e.g. `harvestTokens` fails after emitting
the initial `chips` event), the error event is silently dropped, the loop ends,
and the chip row is left frozen on "loading" with no message to the user. The
lookup consumer (`client.ts:847`) and all three search consumers
(`client.ts:235, 499, 537`) already do the right thing (`throw new Error(evt.error)`);
this plan brings highlights in line.

## Current state

`packages/web/client.ts` — `consumeHighlightStream` (lines 610-635):
```ts
async function consumeHighlightStream(body: ReadableStream<Uint8Array>) {
  const chipMap = new Map<string, UiChip>();
  let lastFailures = 0;
  for await (const evt of readNdjson<HighlightEvent>(body)) {
    switch (evt.type) {
      case 'chips':
        chipMap.clear();
        for (const c of evt.chips) chipMap.set(c.token, { ...c, state: 'loading' });
        renderHighlights([...chipMap.values()]);
        break;
      case 'chip':
        chipMap.set(evt.highlight.token, { ...evt.highlight, state: 'done' });
        renderHighlights([...chipMap.values()]);
        break;
      case 'chip-error': {
        const existing = chipMap.get(evt.token) ?? { token: evt.token, label: evt.label, count: 0 };
        chipMap.set(evt.token, { ...existing, state: 'error', error: evt.error });
        renderHighlights([...chipMap.values()]);
        break;
      }
      case 'done':
        lastFailures = evt.failures;
        renderHighlights([...chipMap.values()], true);
        break;
    }
  }
  if (lastFailures > 0) {
    setStatus(`${lastFailures} highlight${lastFailures === 1 ? '' : 's'} failed — refresh to retry`, true);
  }
}
```

The wire type already carries the variant — `HighlightEvent` in
`packages/gmaps-shared/src/wire.ts:71-76` includes `| { type: 'error'; error: string }`.

The caller, `loadHighlights` (around `client.ts:555-572`), wraps the consume call
in a `try/catch` that surfaces a message via `showHighlightsLoading(...)`:
```ts
try {
  // ... when the response is an NDJSON stream:
  await consumeHighlightStream(resp.body);
  highlightsRefreshBtn.hidden = false;
  return;
  // ...
} catch (e) {
  showHighlightsLoading(`couldn't load highlights — ${e instanceof Error ? e.message : String(e)}`);
}
```
So if `consumeHighlightStream` **throws**, the user already gets a visible error —
the fix is simply to make the `error` event throw, exactly like the other consumers.

The reference pattern — search consumer (`client.ts:235`) and the chip-summary
consumer (`client.ts:499-501`):
```ts
} else if (evt.type === 'error') {
  throw new Error(evt.error);
}
```

Optional secondary hardening — `readNdjson` (`client.ts:42-61`) does
`yield JSON.parse(line) as T` with no guard (`client.ts:55`). The server always
writes `JSON.stringify(obj) + '\n'`, so a malformed line is only possible from
network corruption; impact is low. Included as a small defensive step below.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Web tests | `bun test packages/web/` | all pass |
| (After plan 002) typecheck web | `cd packages/web && bunx tsc --noEmit` | exit 0 |

There is no automated test harness for `client.ts` DOM streaming in this repo, so
verification is by code inspection + (optionally) the typecheck once plan 002 has
landed. Do not invent a DOM test framework for this one-line fix.

## Scope

**In scope**:
- `packages/web/client.ts` — add an `error` case to `consumeHighlightStream`; optionally guard `readNdjson`'s `JSON.parse`.

**Out of scope** (do NOT touch):
- The other consumers — they already handle `error` correctly.
- `server.ts`, `wire.ts` — the producer and types are already correct.
- `loadHighlights`'s `catch` — it already renders the thrown message.

## Git workflow

- Branch: `advisor/005-ndjson-highlights-error`
- Commit style `web: …` to match `git log`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Handle the `error` event in the highlights consumer

In `consumeHighlightStream` (`client.ts`), add an `error` case to the `switch`.
Because the `switch` runs inside the `for await` loop and the function has no outer
`try`, throwing here propagates to `loadHighlights`'s `catch`, which already shows
a message. Add, after the `done` case:
```ts
      case 'done':
        lastFailures = evt.failures;
        renderHighlights([...chipMap.values()], true);
        break;
      case 'error':
        throw new Error(evt.error || 'highlights failed');
```

This matches the wire union (`HighlightEvent` includes `{type:'error'}`) so it is
type-exhaustive; once plan 002's typecheck is in place, omitting it would not error
(the union is open via the `switch`), but adding it is the correct fix.

**Verify**:
- `grep -n "case 'error'" packages/web/client.ts` → now includes a match inside `consumeHighlightStream` (in addition to any pre-existing ones).
- Read the function and confirm the new case sits inside the `switch`, before its
  closing brace.
- `bun test packages/web/` → still all pass (no behavioral test exists for this
  path; you are confirming nothing else broke).

### Step 2 (optional, low-risk): guard `readNdjson` against a malformed line

In `readNdjson` (`client.ts:52-56`), wrap the parse so one corrupt line can't kill
the whole stream with an opaque `SyntaxError`:
```ts
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as T;
        } catch {
          // A corrupted NDJSON line (network glitch) shouldn't abort the stream;
          // skip it. The server always writes well-formed JSON + '\n'.
          console.warn('[readNdjson] skipping unparseable line');
        }
      }
```

**Verify**: `bun test packages/web/` → all pass. Read the diff to confirm the
`try/catch` wraps only the `JSON.parse`/`yield` and the buffer-advance still runs
for every line.

## Test plan

No unit test is added — `client.ts` is browser DOM/streaming code with no existing
test harness in this repo, and the change is a one-case addition mirroring four
sibling consumers that already do exactly this. Verification is structural:
- The `error` case exists in `consumeHighlightStream` and throws.
- `bun test packages/web/` stays green.
- (If plan 002 landed) `cd packages/web && bunx tsc --noEmit` stays green.

If you want a behavioral guard, the honest place for it is an integration test of
the server's `ndjsonStream` error emission — out of scope here; record it as a
follow-up rather than scaffolding a DOM harness for one line.

## Done criteria

ALL must hold:

- [ ] `consumeHighlightStream` in `packages/web/client.ts` has a `case 'error'` that throws.
- [ ] `bun test packages/web/` → all pass.
- [ ] (If plan 002 merged) `cd packages/web && bunx tsc --noEmit` → exit 0.
- [ ] No files outside `packages/web/client.ts` changed (`git status`).
- [ ] `plans/README.md` status row for 005 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- `consumeHighlightStream` already contains an `error` case (someone fixed it
  first) — then this plan is a no-op; mark it REJECTED in the index with that note.
- The drift check shows `client.ts` moved since `4a3a843` and the
  `consumeHighlightStream` excerpt no longer matches.

## Maintenance notes

- Pattern to keep: **every `readNdjson` consumer must handle `evt.type === 'error'`**
  (throw, so the caller's catch surfaces it). There are now five consumers
  (lookup, highlights, three search call sites); a new one must follow suit. A
  reviewer should check this whenever a new NDJSON stream is added to the client.
- The `chip-error` event (per-chip failure) is distinct from `error` (whole-stream
  failure) — the former keeps the other chips alive; the latter aborts. Don't
  collapse them.
