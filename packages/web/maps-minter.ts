// Self-mint a fresh review bgkey, hands-off, no extension. Google serves an
// automated/CDP-driven browser a review-less page — UNLESS the browser is cloaked
// by puppeteer-extra-plugin-stealth, which patches the ~dozen surfaces Google keys
// on (proven: a raw-CDP Chrome and a real one are JS-identical yet get 2 tabs vs 4;
// stealth flips it). Drive the system Chrome (no bundled-Chromium download) through
// the residential proxy to a busy place's reviews deeplink, scroll the panel so the
// qv9Egd ListUgcPosts RPC fires, and lift its x-maps-bgkey + the cookie jar. The
// result is an ANONYMOUS session (consent cookies only) that replays server-side —
// so the server keeps itself seeded with no logged-in state and no human.
import { addExtra } from 'puppeteer-extra';
import puppeteerCore, { type Browser, type HTTPRequest } from 'puppeteer-core';
import Stealth from 'puppeteer-extra-plugin-stealth';
import { buildListReq, parseReviewsResponse } from '@truescore/gmaps-shared';
import { googleFetch, proxyConfig, SEED_COOKIES, REVIEW_PROBE_FID } from './browser';
import type { Seed } from './maps-creds';
import { logEvent } from './events';

const puppeteer = addExtra(puppeteerCore as any);
puppeteer.use(Stealth());

const CHROME = process.env.TRUESCORE_CHROME_PATH || '/usr/bin/google-chrome';
// Eiffel Tower — a permanent landmark with hundreds of thousands of reviews; the
// bgkey is place-independent so any busy place works as the mint target. The !9m1!1b1
// segment is the "open reviews" deeplink — WITHOUT it the reviews never load into the
// DOM (even cloaked), so the qv9Egd RPC never fires. hl=en pins English.
const MINT_FID = REVIEW_PROBE_FID;
const MINT_URL =
  'https://www.google.com/maps/place/Eiffel+Tower/@48.8583701,2.2944813,16z/data=' +
  `!4m8!3m7!1s${MINT_FID}!8m2!3d48.8583701!4d2.2944813!9m1!1b1!16s%2Fm%2F02j81!18m1!1e1?hl=en`;
// Mirrors the 81-tagged sessionId regex in packages/extension/src/sites/gmaps-capture.ts.
const SID_RE = /\["([A-Za-z0-9_-]{16,}?)",null,null,null,null,null,81\]/;
const MINT_TIMEOUT_MS = 70_000;

let inFlight: Promise<Seed | null> | null = null;

// Single-flight: a stale-storm of triggers collapses to one browser launch.
export function mintMapsCreds(): Promise<Seed | null> {
  return (inFlight ??= runMint().finally(() => { inFlight = null; }));
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);

async function runMint(): Promise<Seed | null> {
  const { server, user, pass } = proxyConfig();
  if (!server) { console.warn('[maps-minter] no proxy configured — cannot mint'); return null; }
  const t0 = Date.now();
  let browser: Browser | undefined;
  try {
    const seed = await withTimeout(capture(server, user, pass, (b) => (browser = b)), MINT_TIMEOUT_MS);
    if (!seed) { console.warn(`[maps-minter] no bgkey captured in ${Date.now() - t0}ms`); logEvent('mint', { result: 'fail', reason: 'no-bgkey', ms: Date.now() - t0 }); return null; }
    // Verify the minted creds actually fetch reviews through the server's own path
    // before we trust them — using a cookie override so a bad mint can't clobber the
    // live session's global jar.
    const req = buildListReq(MINT_FID, 'newest', { ...seed, hl: 'en' });
    const { reviews } = parseReviewsResponse(await googleFetch(req.url, req.init, seed.cookies));
    if (!reviews.length) { console.warn('[maps-minter] minted bgkey verified empty — discarding'); logEvent('mint', { result: 'fail', reason: 'verify-empty', ms: Date.now() - t0, bgkey: seed.bgkey.slice(-6) }); return null; }
    console.log(`[maps-minter] minted bgkey …${seed.bgkey.slice(-6)} in ${Date.now() - t0}ms (verify: ${reviews.length} reviews)`);
    logEvent('mint', { result: 'ok', ms: Date.now() - t0, bgkey: seed.bgkey.slice(-6), verify: reviews.length });
    return seed;
  } catch (e) {
    console.warn('[maps-minter] mint error:', e instanceof Error ? e.message : e);
    logEvent('mint', { result: 'fail', reason: 'error', ms: Date.now() - t0, msg: e instanceof Error ? e.message : String(e) });
    return null;
  } finally {
    try { await browser?.close(); } catch {}
  }
}

// The panel scroll: the reviews list lazy-loads on scroll, and that scroll is what
// fires qv9Egd. Scroll every left-panel scroll container to the bottom.
const SCROLL_PANELS = `document.querySelectorAll('div').forEach((d)=>{const r=d.getBoundingClientRect();if(r.left<560&&r.width>240&&d.scrollHeight>d.clientHeight+300){const s=getComputedStyle(d);if(s.overflowY==='auto'||s.overflowY==='scroll')d.scrollTop=d.scrollHeight;}})`;

async function capture(
  proxyServer: string,
  proxyUser: string,
  proxyPass: string,
  setBrowser: (b: Browser) => void,
): Promise<Seed | null> {
  const browser: Browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check', `--proxy-server=${proxyServer.replace(/^https?:\/\//, '')}`, '--window-size=1300,2000'],
  });
  setBrowser(browser);
  const page = await browser.newPage();
  if (proxyUser) await page.authenticate({ username: proxyUser, password: proxyPass });

  // Grab the bgkey + bgbind + POST body off the one qv9Egd batchexecute (the review
  // RPC — the only batchexecute carrying x-maps-bgkey). Field extraction mirrors
  // packages/extension/src/sites/gmaps-capture.ts.
  type Cap = { bgkey: string; bgbind: string; postData: string };
  let cap: Cap | null = null;
  page.on('request', (r: HTTPRequest) => {
    try {
      if (!r.url().includes('batchexecute')) return;
      const h = r.headers();
      if (h['x-maps-bgkey'] && !cap) cap = { bgkey: h['x-maps-bgkey'], bgbind: h['x-maps-bgbind'] || '', postData: r.postData() || '' };
    } catch { /* keep going */ }
  });

  // Consent bypass so an EU proxy exit doesn't land on the "before you continue" wall.
  await page.setCookie(...Object.entries(SEED_COOKIES).map(([name, value]) => ({ name, value, domain: '.google.com', path: '/' })));
  await page.goto(MINT_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  for (let i = 0; i < 30 && !cap; i++) { await new Promise((r) => setTimeout(r, 1000)); await page.evaluate(SCROLL_PANELS).catch(() => {}); }
  const got = cap as Cap | null; // re-widen: TS narrows a closure-assigned var to its init
  if (!got) return null;

  const cookies = (await page.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  let decoded = got.postData; try { decoded = decodeURIComponent(got.postData); } catch { /* raw */ }
  const sessionId = (got.bgbind.match(SID_RE) || decoded.match(SID_RE) || [])[1] || '';
  const atRaw = (got.postData.match(/(?:^|&)at=([^&]+)/) || [])[1];
  return { bgkey: got.bgkey, bgbind: got.bgbind, sessionId, at: atRaw ? decodeURIComponent(atRaw) : '', cookies };
}
