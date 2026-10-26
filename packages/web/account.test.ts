import { test, expect, afterEach } from 'bun:test';
import { rmSync, statSync } from 'fs';
import { COOKIES_PATH } from './browser';

const SAVED = COOKIES_PATH.replace(/cookies\.json$/, 'account.json');
const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.TRUESCORE_ACCOUNT_COOKIES;
  rmSync(SAVED, { force: true });
});

// account.ts reads its env at import, so each case takes a fresh instance: a restart.
const boot = (cookies: string) => {
  process.env.TRUESCORE_ACCOUNT_COOKIES = cookies;

  // SAFETY: the query only makes a fresh instance of ./account.
  return import(`./account?${Math.random()}`) as Promise<typeof import('./account')>;
};

// Not a Response: test-setup's happy-dom one drops Set-Cookie, as a browser's would.
const googleRotatesTo = (psidts: string) => {
  const headers = { getAll: (_name: 'set-cookie') => [`__Secure-1PSIDTS=${psidts}; Path=/; Domain=.google.com`] };
  // SAFETY: rotateCookies reads only the reply's ok, status and Set-Cookie lines, and never fetch.preconnect.
  globalThis.fetch = (async (_input: string) => ({ ok: true, status: 200, headers }) as Response) as typeof fetch;
};

test('a rotation is saved for the owner only, and outlives a restart', async () => {
  googleRotatesTo('new');
  expect(await (await boot('SID=s; __Secure-1PSIDTS=old')).rotateAccount()).toBe('SID=s; __Secure-1PSIDTS=new');
  expect(statSync(SAVED).mode & 0o777).toBe(0o600);
  expect(await (await boot('SID=s; __Secure-1PSIDTS=old')).accountCookies()).toBe('SID=s; __Secure-1PSIDTS=new');
});

test('a new sign-in in the env supersedes the saved jar', async () => {
  googleRotatesTo('new');
  await (await boot('SID=s; __Secure-1PSIDTS=old')).rotateAccount();
  expect(await (await boot('SID=t; __Secure-1PSIDTS=t0')).accountCookies()).toBe('SID=t; __Secure-1PSIDTS=t0');
});

test('a refused rotation keeps the cookies it had', async () => {
  // SAFETY: rotateCookies only calls fetch, never fetch.preconnect.
  globalThis.fetch = (async (_input: string) => new Response('', { status: 401 })) as typeof fetch;
  const account = await boot('SID=s; __Secure-1PSIDTS=old');
  await expect(account.rotateAccount()).rejects.toThrow('RotateCookies 401');
  expect(await account.accountCookies()).toBe('SID=s; __Secure-1PSIDTS=old');
});

test('no account means a signed-out mint', async () => {
  expect(await (await boot('')).accountCookies()).toBe('');
});
