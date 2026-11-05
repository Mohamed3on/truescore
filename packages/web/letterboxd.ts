import { rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { DB_PATH } from './db';

// Letterboxd rating histograms the extension parses on letterboxd.com, kept by slug
// for the IPTV app on this box, which reads the file directly (no API hop): ten
// half-star counts (½★ to 5★), the film's TMDB id (null once looked up and absent,
// or not a movie) and when it was last sent. A JSON file, written whole and renamed
// into place so a reader never sees half of one.
const PATH = process.env.TRUESCORE_LETTERBOXD_PATH || `${dirname(DB_PATH)}/letterboxd.json`;

type Film = { h: number[]; tmdb?: number | null; at: number };

const films: Record<string, Film> = await Bun.file(PATH).json().catch(() => ({}));

export const LETTERBOXD_BATCH = z.object({
  films: z.array(z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/).max(200),
    h: z.array(z.number().int().nonnegative()).length(10),
    tmdb: z.number().int().positive().optional(),
  })).max(500),
});

let saving: Promise<void> | null = null;

const save = () => {
  saving ??= Bun.sleep(5000)
    .then(() => Bun.write(`${PATH}.tmp`, JSON.stringify(films)))
    .then(() => rename(`${PATH}.tmp`, PATH))
    .catch((e) => console.error('[letterboxd] save', e))
    .finally(() => { saving = null; });
};

export function putHistograms(batch: z.infer<typeof LETTERBOXD_BATCH>['films'], at = Date.now()) {
  for (const { slug, h, tmdb } of batch) films[slug] = { h, tmdb: tmdb ?? films[slug]?.tmdb, at };
  save();
}

// Films sent without a TMDB id get it from their Letterboxd page, one every few
// seconds; a refusal pauses the lookups for ten minutes.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function resolveNext(): Promise<number> {
  const [slug, film] = Object.entries(films).find(([, f]) => f.tmdb === undefined) ?? [];

  if (!slug || !film) return 60_000;
  const res = await fetch(`https://letterboxd.com/film/${slug}/`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) }).catch(() => null);

  if (!res || (!res.ok && res.status !== 404)) return 600_000;
  const html = res.ok ? await res.text() : '';
  film.tmdb = html.includes('data-tmdb-type="movie"') ? Number(html.match(/data-tmdb-id="(\d+)"/)?.[1]) || null : null;
  save();

  return 3000;
}

const resolveLoop = async (): Promise<void> => void setTimeout(resolveLoop, await resolveNext().catch(() => 600_000));

void resolveLoop();
