// One structured, greppable event log for the Maps-session lifecycle, mirrored to
// sqlite so an incident is a `journalctl -g '\[ts-event\]'` tail or a SQL query —
// not an archaeology dig across scattered warn() lines (which is exactly how every
// past session-staleness debug went). Each event is a single line:
//   [ts-event] type=<t> k=v k=v …
// and one row in session_events. logEvent NEVER throws: telemetry must not be able
// to break a lookup. Shares the one sqlite handle from db.ts (WAL) — no second
// connection, no contention.
import { db } from './db';

db.run('CREATE TABLE IF NOT EXISTS session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, data TEXT)');
db.run('CREATE INDEX IF NOT EXISTS idx_session_events_ts ON session_events (ts)');
const insertStmt = db.prepare<void, [number, string, string]>('INSERT INTO session_events (ts, type, data) VALUES (?, ?, ?)');
const pruneStmt = db.prepare<void, [number]>('DELETE FROM session_events WHERE ts < ?');
const RETAIN_MS = 14 * 24 * 60 * 60 * 1000; // two weeks of history is plenty for a one-box app
let lastPrune = 0;

// Render a scalar value for the log line: bare when safe, quoted when it has
// whitespace, quotes, or '='. Keeps lines both human-scannable and splittable.
const fmtVal = (v: unknown): string => {
  const s = String(v);
  return /[\s"'=]/.test(s) ? JSON.stringify(s) : s;
};

export function logEvent(type: string, data: Record<string, unknown> = {}): void {
  const ts = Date.now();
  const kv = Object.entries(data).map(([k, v]) => `${k}=${fmtVal(v)}`).join(' ');
  console.log(`[ts-event] type=${type}${kv ? ' ' + kv : ''}`);
  try {
    insertStmt.run(ts, type, JSON.stringify(data));
    if (ts - lastPrune > 3_600_000) { lastPrune = ts; pruneStmt.run(ts - RETAIN_MS); } // prune at most hourly
  } catch { /* telemetry must never break the caller */ }
}
