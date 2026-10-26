import { writeFile } from 'node:fs/promises';
import { COOKIES_PATH, rotateCookies } from './browser';

// The Google account the server reads reviews as (see maps-minter): its Cookie header,
// as last rotated. Google signs out a session whose __Secure-1PSIDTS stops rotating, so
// the server rotates it the way a signed-in browser does, and keeps the result on disk
// (mode 600) so a restart doesn't fall back to the env's older copy. A different
// TRUESCORE_ACCOUNT_COOKIES (a new sign-in) supersedes what's on disk.
const SEED = process.env.TRUESCORE_ACCOUNT_COOKIES ?? '';
const SAVED_PATH = COOKIES_PATH.replace(/cookies\.json$/, 'account.json');
const seed = Bun.hash(SEED).toString(36);
let jar: Promise<string> | null = null;

/** The account's cookies, or '' when there's no account (the mint goes out signed out). */
export const accountCookies = (): Promise<string> =>
  (jar ??= SEED
    ? Bun.file(SAVED_PATH).json().then((saved) => (saved.seed === seed ? saved.cookies : SEED), () => SEED)
    : Promise.resolve(''));

/** Rotates the account's cookies and saves them. Throws, keeping the old ones, when Google or the proxy refuses. */
export async function rotateAccount(): Promise<string> {
  const cookies = await rotateCookies(await accountCookies());
  jar = Promise.resolve(cookies);
  await writeFile(SAVED_PATH, JSON.stringify({ seed, cookies }), { mode: 0o600 });

  return cookies;
}
