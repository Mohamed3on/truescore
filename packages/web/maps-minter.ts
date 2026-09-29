// Self-mint a fresh review bgkey, hands-off, no extension. Google serves an
// automated/CDP-driven browser a review-less page — UNLESS the browser is cloaked
// by puppeteer-extra-plugin-stealth, which patches the ~dozen surfaces Google keys
// on (proven: a raw-CDP Chrome and a real one are JS-identical yet get 2 tabs vs 4;
// stealth flips it). Drive the system Chrome (no bundled-Chromium download) through
// the residential proxy to a busy place's reviews deeplink, scroll the panel so the
// qv9Egd ListUgcPosts RPC fires, and lift its session + the cookie jar. The
// result is an ANONYMOUS session (consent cookies only) that replays server-side —
// so the server keeps itself seeded with no logged-in state and no human. Google
// binds each bgkey to its exact request (gmaps-shared botguard), so the page stays
// open after the mint and signs every review request of its session until the next
// mint replaces it.
import { addExtra } from 'puppeteer-extra';
import puppeteerCore, { type Browser, type HTTPRequest, type Page } from 'puppeteer-core';
import Stealth from 'puppeteer-extra-plugin-stealth';
import { credsFromBatchExecute, installMapsSigner, PAGE_SIZE, type Signer } from '@truescore/gmaps-shared';
import { verifyReviewsLoad, proxyConfig, SEED_COOKIES, REVIEW_PROBE_FID } from './browser';
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
const MINT_TIMEOUT_MS = 70_000;

let inFlight: Promise<Seed | null> | null = null;
// The browser whose page signs for the adopted session; closed when a newer mint takes over.
let live: Browser | null = null;
// Google caps some fresh sessions at 5 reviews a request with no next page; the next
// browser usually lands an uncapped one.
const MINT_ATTEMPTS = 3;

// Single-flight: a stale-storm of triggers collapses to one browser launch.
export function mintMapsCreds(): Promise<Seed | null> {
  return (inFlight ??= (async () => {
    for (let i = 0; i < MINT_ATTEMPTS; i++) {
      const seed = await runMint();
      if (seed) return seed;
    }
    return null;
  })().finally(() => { inFlight = null; }));
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);

async function runMint(): Promise<Seed | null> {
  const { server, user, pass } = proxyConfig();
  if (!server) { console.warn('[maps-minter] no proxy configured — cannot mint'); return null; }
  const t0 = Date.now();
  let browser: Browser | undefined;
  let adopted = false;
  try {
    const seed = await withTimeout(capture(server, user, pass, (b) => (browser = b)), MINT_TIMEOUT_MS);
    if (!seed) { console.warn(`[maps-minter] no bgkey captured in ${Date.now() - t0}ms`); logEvent('mint', { result: 'fail', reason: 'no-bgkey', ms: Date.now() - t0 }); return null; }
    // Verify the minted session actually serves reviews, signed by its own page, before
    // we trust it — via a cookie override so a bad mint can't clobber the live session's
    // global jar.
    // The probe place always fills a page, so a short one is a session Google caps:
    // 5 reviews a page and no next page, which scored every place from 10 reviews.
    const verify = await verifyReviewsLoad({ ...seed, hl: 'en' }, seed.cookies, seed.sign);
    if (verify < PAGE_SIZE) { console.warn(`[maps-minter] minted bgkey verified ${verify} reviews — discarding`); logEvent('mint', { result: 'fail', reason: verify ? 'verify-capped' : 'verify-empty', ms: Date.now() - t0, bgkey: seed.bgkey.slice(-6) }); return null; }
    console.log(`[maps-minter] minted bgkey …${seed.bgkey.slice(-6)} in ${Date.now() - t0}ms (verify: ${verify} reviews)`);
    logEvent('mint', { result: 'ok', ms: Date.now() - t0, bgkey: seed.bgkey.slice(-6), verify });
    void live?.close().catch(() => {});
    live = browser ?? null;
    adopted = true;
    return seed;
  } catch (e) {
    console.warn('[maps-minter] mint error:', e instanceof Error ? e.message : e);
    logEvent('mint', { result: 'fail', reason: 'error', ms: Date.now() - t0, msg: e instanceof Error ? e.message : String(e) });
    return null;
  } finally {
    if (!adopted) try { await browser?.close(); } catch {}
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
  // Before any Maps script runs, so the page can sign our requests later.
  await page.evaluateOnNewDocument(installMapsSigner);

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
  return { ...credsFromBatchExecute(got.bgkey, got.bgbind, got.postData), cookies, sign: signerFor(page) };
}

// The page resolves null itself when it can't sign; a dead or hung page counts as can't.
const signerFor = (page: Page): Signer => (request) =>
  withTimeout(page.evaluate((r) => (window as any).__truescoreSignMaps(r) as Promise<string | null>, request), 10_000).catch(() => null);
