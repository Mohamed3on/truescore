// One-off: extract real review sets from a cache DB into fixtures.json.
//   bun evals/make-fixtures.ts /tmp/ts-cache.sqlite
import { Database } from 'bun:sqlite';
import { textReviewsFor } from '@truescore/gmaps-shared';

const MAX_TEXTS = 60; // longest-first (textReviewsFor sorts); enough to be representative

// No readonly: the file is a local copy, and readonly+WAL can't open without
// the sidecar -shm/-wal files.
const db = new Database(process.argv[2] ?? '/tmp/ts-cache.sqlite');

type Fixture = { place: string; filter: string | null; reviewTexts: string[] };
const places: Array<Fixture & { n: number }> = [];
let search: Fixture | undefined;

for (const row of db.prepare<{ data: string }, []>('SELECT data FROM entries').iterate()) {
  let e: any;
  try { e = JSON.parse(row.data); } catch { continue; }
  const texts = e?.score?.reviews ? textReviewsFor(e.score.reviews) : [];
  if (e?.name && texts.length >= 40) places.push({ place: e.name, filter: null, reviewTexts: texts.slice(0, MAX_TEXTS), n: texts.length });
  if (!search && e?.name && e?.searches) {
    for (const [q, s] of Object.entries<any>(e.searches)) {
      const st = textReviewsFor(s.reviews ?? []);
      if (st.length >= 15) { search = { place: e.name, filter: q, reviewTexts: st.slice(0, MAX_TEXTS) }; break; }
    }
  }
}

places.sort((a, b) => b.n - a.n);
const fixtures: Fixture[] = [
  ...places.slice(0, 2).map(({ n, ...f }) => f),
  ...(search ? [search] : []),
];
await Bun.write(`${import.meta.dir}/fixtures.json`, JSON.stringify(fixtures, null, 1));
console.log(fixtures.map((f) => `${f.place}${f.filter ? ` [${f.filter}]` : ''}: ${f.reviewTexts.length} texts`).join('\n'));
