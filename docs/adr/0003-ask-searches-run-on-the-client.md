# 3. An Ask's Searches run on the client; the server only thinks

Date: 2026-09-15
Status: Accepted

When an Ask's Sample doesn't settle the question, the model runs Searches over
every review of the Place. Those Searches run on the client — the extension
through its own tab's Maps session, the web through `/api/search` — not inside
`/api/ask`, although AI SDK's server-side tool loop would do it in one request.
The extension's tab session is live and the user's own, where the server's is a
single shared session that goes stale; running there also keeps `/api/ask`
LLM-only, as the extension's shipped-in Sample already assumed.

## Considered Options

- **Server-side tool loop** (`execute` on the tool, `stopWhen`) — one request,
  but every extension user's Searches on the server's Maps session.
- **Pasting the matches back into the prompt as text** — simplest stateless
  re-ask, but drops the model's own tool call and the provider data riding on it
  (reasoning items, Gemini thought signatures).

## Consequences

- `/api/ask` is one round per request. The search tool has no `execute`, so the
  model's call ends the round; the client runs it and posts again with `history`
  (the model's messages, echoed back verbatim — streamText validates them) and
  the matches, which the server appends as tool results. The server holds no
  state between rounds.
- One extra round trip per Search, and the extension re-uploads its Sample each
  round.
- The loop lives once in `gmaps-shared` (`runAsk`); each client supplies only
  its own search.
