import { rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { DB_PATH } from './db';

// Letterboxd films the extension sees on letterboxd.com, kept by slug for the IPTV
// app on this box, which reads the file directly (no API hop): ten half-star counts
// (½★ to 5★) and the film's TrueScore (score, net-loved ratio; adjusted, that score on
// its newest recentTotal reviews), any possibly absent,
// the film's TMDB id (null once looked up and absent, or not a movie) and when it was
// last sent. A JSON file, written whole and renamed into place so a reader never sees
// half of one.
const PATH = process.env.TRUESCORE_LETTERBOXD_PATH || `${dirname(DB_PATH)}/letterboxd.json`;

type Film = { h?: number[]; score?: number; ratio?: number; adjusted?: number; recentTotal?: number; tmdb?: number | null; at: number };

const films: Record<string, Film> = await Bun.file(PATH).json().catch(() => ({}));

export const LETTERBOXD_BATCH = z.object({
  films: z.array(z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/).max(200),
    h: z.array(z.number().int().nonnegative()).length(10).optional(),
    score: z.number().finite().optional(),
    ratio: z.number().min(-1).max(1).optional(),
    adjusted: z.number().finite().optional(),
    recentTotal: z.number().int().nonnegative().optional(),
    tmdb: z.number().int().positive().optional(),
  })).max(500),
  list: z.object({
    link: z.string().regex(/^\/[\w-]+\/list\/[\w-]+\/$/).max(300),
    name: z.string().min(1).max(300),
    slugs: z.array(z.string().regex(/^[a-z0-9-]+$/).max(200)).max(500),
    likes: z.number().int().nonnegative().optional(),
  }).optional(),
});

// The Letterboxd lists the extension's picks were read from, by link ("/user/list/name/"):
// its name, its films' slugs in the order read (the top of the list down to the film the
// picks were for), its likes and when it was last sent. The IPTV app makes rows of the most
// liked; kept beside the films the same way.
const LISTS_PATH = `${dirname(PATH)}/letterboxd-lists.json`;

type List = { name: string; slugs: string[]; likes?: number; at: number };

const lists: Record<string, List> = await Bun.file(LISTS_PATH).json().catch(() => ({}));

/** Writes [data] to [path] 5 s after the first change, whole and renamed into place. */
const saver = (path: string, data: Record<string, Film | List>) => {
  let saving: Promise<void> | null = null;

  return () => {
    saving ??= Bun.sleep(5000)
      .then(() => Bun.write(`${path}.tmp`, JSON.stringify(data)))
      .then(() => rename(`${path}.tmp`, path))
      .catch((e) => console.error('[letterboxd] save', e))
      .finally(() => { saving = null; });
  };
};

const save = saver(PATH, films);
const saveLists = saver(LISTS_PATH, lists);

export function putFilms(batch: z.infer<typeof LETTERBOXD_BATCH>['films'], at = Date.now()) {
  for (const { slug, ...film } of batch) films[slug] = { ...films[slug], ...film, tmdb: film.tmdb ?? films[slug]?.tmdb, at };
  save();
}

export function putList({ link, name, slugs, likes }: NonNullable<z.infer<typeof LETTERBOXD_BATCH>['list']>, at = Date.now()) {
  lists[link] = { name, slugs, likes: likes ?? lists[link]?.likes, at };
  saveLists();
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
