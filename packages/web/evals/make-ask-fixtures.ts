// One-off: pull every review behind a few places' topic chips out of a cache DB
// as the "every review" evals/ask.ts searches over. Prints JSON — megabytes of
// third-party review text, so the output stays gitignored:
//   ssh root@65.108.153.112 'cat > /tmp/m.ts && bun /tmp/m.ts' < evals/make-ask-fixtures.ts > evals/fixtures/ask-corpora.json
import { Database } from 'bun:sqlite';

const PLACES = ['Güerrín', 'Coves del Drach', "Caru' cu bere"];
const db = new Database(process.argv[2] ?? '/var/lib/truescore/cache.sqlite', { readonly: true });

const corpora: Record<string, unknown[]> = {};
const rows = db.prepare<{ data: string }, string[]>(`SELECT data FROM entries WHERE json_extract(data, '$.name') IN (${PLACES.map(() => '?').join()})`).all(...PLACES);
for (const { data } of rows) {
  const e = JSON.parse(data);
  const byId = new Map<string, any>();
  for (const chip of e.highlights ?? []) for (const { reviewId, stars, reviewerReviewCount, timestamp, text } of chip.reviews ?? []) byId.set(reviewId, { reviewId, stars, reviewerReviewCount, timestamp, text });
  corpora[e.name] = [...byId.values()].filter((r) => r.text.length > 1);
}
console.log(JSON.stringify(corpora));
