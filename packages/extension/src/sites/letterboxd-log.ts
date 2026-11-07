// Logs on Letterboxd the films Sofa (the owner's TV app) was asked to log. Letterboxd has no API for personal
// projects and Cloudflare lets only a real browser write to it, so a mark or a film finished on the TV waits on the box
// until a Letterboxd page is open here. Each goes in as the site's own diary entry (its log form's request), on the day
// it was watched and with its rating, and the box is told which went in. With nothing waiting (anyone but the owner,
// whose server has no queue), nothing happens.

/** A film to log: TMDB's id, when it was watched (epoch ms), the rating out of 10 (Letterboxd's half stars). */
type Log = { tmdb: number; at: number; rating?: number };

/** The page's CSRF token, which every Letterboxd page sets inline (its cookie is HttpOnly). */
const csrf = () =>
  [...document.scripts].map((s) => s.textContent?.match(/supermodelCSRF\s*=\s*['"]([^'"]+)['"]/)?.[1]).find(Boolean);

/** "2026-11-07": [at] in this browser's own day. */
const day = (at: number) => {
  const d = new Date(at);

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Logs [l] as a diary entry; true once Letterboxd took it. */
async function log(l: Log, token: string): Promise<boolean> {
  // letterboxd.com/tmdb/<id>/ redirects to the film's page, which names its Letterboxd id.
  const page = await fetch(`/tmdb/${l.tmdb}/`, { credentials: 'include' });
  const film = page.ok ? (await page.text()).match(/data-production-uid="(film:\d+)"/)?.[1] : undefined;

  if (!film) return false;

  const body = new URLSearchParams({
    __csrf: token, viewingableUid: film, specifiedDate: 'true', viewingDateStr: day(l.at), rating: String(l.rating ?? 0), review: '', tags: '',
  });

  const r = await fetch('/s/save-diary-entry', { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' }, body });
  // The form's answer is JSON; Cloudflare's check or a signed-out page is HTML, and a refusal says result: false.
  const answer = r.ok && r.headers.get('content-type')?.includes('json') ? await r.json().catch(() => null) : null;

  return !!answer && answer.result !== false;
}

// One tab at a time logs (a lock every Letterboxd tab shares), so two pages opening together never log a film twice.
void navigator.locks.request('truescore-letterboxd-log', { ifAvailable: true }, async (lock) => {
  if (!lock) return;

  const logs: Log[] = await chrome.runtime.sendMessage({ type: 'lbxLogs' }).catch(() => []);
  const token = logs?.length ? csrf() : undefined;

  if (!token) return;

  const done: Log[] = [];

  for (const l of logs) if (await log(l, token).catch(() => false)) done.push(l);

  if (done.length) await chrome.runtime.sendMessage({ type: 'lbxLogged', done }).catch(() => {});
});
