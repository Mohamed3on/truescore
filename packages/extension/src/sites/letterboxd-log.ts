// Logs on Letterboxd the films Sofa (the owner's TV app) was asked to log. Letterboxd has no API for personal
// projects and Cloudflare lets only a real browser write to it, so a mark or a film finished on the TV waits on the box
// until a Letterboxd page is open here. Each goes in as a diary entry through the site's own API, on the day it was
// watched and with its rating, and the box is told which went in. The queue names the Letterboxd account it is
// for: anyone else signed in here (the TrueScore password is shared) logs nothing and takes nothing off it. With
// nothing waiting (anyone without the owner's server), nothing happens.

/** A film to log: TMDB's id, when it was watched (epoch ms), the rating out of 10 (Letterboxd's half stars). */
type Log = { tmdb: number; at: number; rating?: number };

/** A value every Letterboxd page sets inline: the CSRF token (its cookie is HttpOnly) or the signed-in username. */
const inline = (re: RegExp) => [...document.scripts].map((s) => s.textContent?.match(re)?.[1]).find(Boolean);

/** "2026-11-07": [at] in this browser's own day. */
const day = (at: number) => {
  const d = new Date(at);

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The film's Letterboxd id ("ipoi"), from its page: letterboxd.com/tmdb/<id>/ redirects there. */
async function filmId(tmdb: number): Promise<string | undefined> {
  const page = await fetch(`/tmdb/${tmdb}/`, { credentials: 'include' });

  return page.ok ? (await page.text()).replace(/&quot;/g, '"').match(/"lid":"(\w+)","uid":"film:/)?.[1] : undefined;
}

/**
 * Logs [l] as a diary entry through the API Letterboxd's own pages call (/api/v0, signed in by the session, the page's
 * token in X-CSRF-TOKEN); the rating in stars. True once Letterboxd answered with the entry. A Cloudflare check
 * (which the site's pages would show) fails it, and the next page tries again.
 */
async function log(l: Log, token: string): Promise<boolean> {
  const productionId = await filmId(l.tmdb);

  if (!productionId) return false;

  const r = await fetch('/api/v0/production-log-entries', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', Accept: 'application/json', 'X-CSRF-TOKEN': token },
    body: JSON.stringify({ productionId, diaryDetails: { diaryDate: day(l.at), rewatch: false }, tags: [], like: false, ...(l.rating && { rating: l.rating / 2 }) }),
  });

  return r.ok && !!(await r.json().catch(() => null))?.logEntry;
}

// One tab at a time logs (a lock every Letterboxd tab shares), so two pages opening together never log a film twice.
void navigator.locks.request('truescore-letterboxd-log', { ifAvailable: true }, async (lock) => {
  if (!lock) return;

  const queue: { user?: string | null; logs?: Log[] } | null = await chrome.runtime.sendMessage({ type: 'lbxLogs' }).catch(() => null);
  const logs = queue?.logs ?? [];
  const signedIn = inline(/person\.username\s*=\s*['"]([^'"]+)['"]/);
  const mine = !!queue?.user && signedIn?.toLowerCase() === queue.user.toLowerCase();
  const token = mine && logs.length ? inline(/supermodelCSRF\s*=\s*['"]([^'"]+)['"]/) : undefined;

  if (!token) return;

  const done: Log[] = [];

  for (const l of logs) if (await log(l, token).catch(() => false)) done.push(l);

  if (done.length) await chrome.runtime.sendMessage({ type: 'lbxLogged', done }).catch(() => {});
});
