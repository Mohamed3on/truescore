// Makes on Letterboxd the changes Sofa (the owner's TV app) was asked for. Letterboxd has no API for personal projects
// and Cloudflare lets only a real browser write to it, so a mark, rating, finished film or watchlist removal on the TV
// waits on the box until a Letterboxd page is open here. Each goes in through the API the site's own pages call: a diary
// entry on the day it was watched (a rewatch when Letterboxd has it watched already), the film's rating set or cleared,
// the app's own diary entries deleted when it was marked unwatched, the film taken off the watchlist; and the box is told
// which parts went in. The queue names the Letterboxd account it is for: anyone else signed in here (the TrueScore
// password is shared) changes nothing and takes nothing off it. With nothing waiting (anyone without the owner's
// server), nothing happens.

/** What one film should come to (see Sofa's lib/letterboxd-log.ts): each part only when the TV asked for it. */
type Log = { tmdb: number; at: number; log?: true; rating?: number | null; unlog?: string[]; watchlist?: boolean };

/** What the API takes: a diary entry, a rating (in stars, null to clear) or a watchlist change. */
type ApiBody =
  | { productionId: string; diaryDetails: { diaryDate: string; rewatch: boolean }; tags: string[]; like: boolean; rating?: number | null }
  | { rating: number | null }
  | { inWatchlist: boolean };

/** The parts of a [Log] that went in, and the Letterboxd id of the diary entry it added. */
type Done = Log & { made?: string };

/** A value every Letterboxd page sets inline: the CSRF token (its cookie is HttpOnly) or the signed-in username. */
const inline = (re: RegExp) => [...document.scripts].map((s) => s.textContent?.match(re)?.[1]).find(Boolean);

/** "2026-11-07": [at] in this browser's own day. */
const day = (at: number) => {
  const d = new Date(at);

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The film's Letterboxd ids ("ipoi", "film:438751"), from its page's own production:identifier tag: letterboxd.com/tmdb/<id>/ redirects there. */
async function filmIds(tmdb: number): Promise<{ lid: string; uid: string } | undefined> {
  const page = await fetch(`/tmdb/${tmdb}/`, { credentials: 'include' });

  if (!page.ok) return undefined;

  const tag = new DOMParser().parseFromString(await page.text(), 'text/html').head.querySelector('meta[name="production:identifier"]');
  // Its content is the film's ids as JSON, the Letterboxd id first: {"lid":"ipoi","uid":"film:438751",…}.
  const ids = tag?.getAttribute('content')?.match(/^\{"lid":"(\w+)","uid":"(film:\d+)"/);

  return ids ? { lid: ids[1], uid: ids[2] } : undefined;
}

/** Whether Letterboxd has the film ([uid]) watched already: a new entry is then a rewatch. */
async function watched(uid: string): Promise<boolean> {
  const r = await fetch('/ajax/letterboxd-metadata/', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['productions', uid]]),
  });

  const meta: { watched?: string[] } | null = r.ok ? await r.json().catch(() => null) : null;

  return !!meta?.watched?.includes(uid);
}

/**
 * Deletes a diary entry the app made, by its Letterboxd [id], if it is [user]'s: the API reads it (it won't delete one),
 * its page names the site's own number for it, and the site's delete takes that. True once it's gone (gone already too).
 */
async function unlog(id: string, user: string, token: string): Promise<boolean> {
  const r = await fetch(`/api/v0/log-entry/${id}`, { credentials: 'include', headers: { Accept: 'application/json' } });

  if (r.status === 404) return true;

  const entry: { owner?: { username?: string }; links?: { type?: string; url?: string }[] } | null = r.ok ? await r.json().catch(() => null) : null;
  const page = entry?.links?.find((l) => l.type === 'letterboxd')?.url;

  if (!page || entry?.owner?.username?.toLowerCase() !== user.toLowerCase()) return false;

  const html = await fetch(new URL(page, location.origin).pathname, { credentials: 'include' }).then((p) => (p.ok ? p.text() : ''));
  const viewings = [...new Set([...html.matchAll(/viewing:(\d+)/g)].map((m) => m[1]))];

  if (viewings.length !== 1) return false;

  const body = new URLSearchParams({ __csrf: token });

  return (await fetch(`/s/viewing:${viewings[0]}/delete`, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' }, body })).ok;
}

/**
 * Makes [l]'s changes through the API the site's own pages call (/api/v0, signed in by the session, the page's token in
 * X-CSRF-TOKEN; ratings in stars; deletes as [unlog]), stopping at the first one Letterboxd refuses (a Cloudflare check, which the site's
 * pages would show, included): the parts made before it go back as done, the rest wait for the next page.
 */
async function apply(l: Log, user: string, token: string): Promise<Done | null> {
  const film = await filmIds(l.tmdb);

  if (!film) return null;

  const api = (path: string, method: string, body?: ApiBody) => fetch(`/api/v0${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', Accept: 'application/json', 'X-CSRF-TOKEN': token },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  const done: Done = { tmdb: l.tmdb, at: l.at };
  const stars = (rating: number | null) => (rating ? rating / 2 : null);

  try {
    if (l.unlog?.length) {
      for (const id of l.unlog) if (!(await unlog(id, user, token))) return null;

      done.unlog = l.unlog;
    }

    if (l.log) {
      const r = await api('/production-log-entries', 'POST', {
        productionId: film.lid, diaryDetails: { diaryDate: day(l.at), rewatch: await watched(film.uid) }, tags: [], like: false, ...(l.rating && { rating: stars(l.rating) }),
      });

      const made: { logEntry?: { id?: string } } | null = r.ok ? await r.json().catch(() => null) : null;

      if (!made?.logEntry?.id) return done.unlog ? done : null;

      Object.assign(done, { log: true, made: made.logEntry.id }, l.rating && { rating: l.rating });
    }

    // A rating that didn't go with a new entry: set or cleared on the film itself.
    if (l.rating !== undefined && done.rating === undefined) {
      if (!(await api(`/me/rate/${film.lid}`, 'PATCH', { rating: stars(l.rating) })).ok) return done.unlog || done.log ? done : null;

      done.rating = l.rating;
    }

    if (l.watchlist !== undefined) {
      if ((await api(`/me/watchlist/${film.lid}`, 'PATCH', { inWatchlist: l.watchlist })).ok) done.watchlist = l.watchlist;
    }
  } catch {
    // Offline or refused mid-way: what went in so far goes back.
  }

  return done.unlog || done.log || done.rating !== undefined || done.watchlist !== undefined ? done : null;
}

// One tab at a time (a lock every Letterboxd tab shares), so two pages opening together never make a change twice.
void navigator.locks.request('truescore-letterboxd-log', { ifAvailable: true }, async (lock) => {
  if (!lock) return;

  const queue: { user?: string | null; logs?: Log[] } | null = await chrome.runtime.sendMessage({ type: 'lbxLogs' }).catch(() => null);
  const logs = queue?.logs ?? [];
  const signedIn = inline(/person\.username\s*=\s*['"]([^'"]+)['"]/);
  const mine = !!queue?.user && signedIn?.toLowerCase() === queue.user.toLowerCase();
  const token = mine && logs.length ? inline(/supermodelCSRF\s*=\s*['"]([^'"]+)['"]/) : undefined;

  if (!token) return;

  const done: Done[] = [];

  for (const l of logs) {
    const d = await apply(l, queue!.user!, token).catch(() => null);

    if (d) done.push(d);
  }

  if (done.length) await chrome.runtime.sendMessage({ type: 'lbxLogged', done }).catch(() => {});
});
