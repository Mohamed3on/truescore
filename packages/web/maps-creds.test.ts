import { test, expect, describe, afterEach } from 'bun:test';

// maps-creds resolves the env session lazily, but caches it once adopted — so
// each case needs a fresh module instance.
const freshModule = async () => {
  const url = `./maps-creds?${Math.random()}`;
  return import(url) as Promise<typeof import('./maps-creds')>;
};

const ENV_KEYS = ['TRUESCORE_MAPS_BGKEY', 'TRUESCORE_MAPS_BGBIND', 'TRUESCORE_MAPS_SESSION', 'TRUESCORE_MAPS_AT', 'TRUESCORE_MAPS_COOKIES'] as const;
const setEnv = (vals: Partial<Record<(typeof ENV_KEYS)[number], string>>) => {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vals);
};
afterEach(() => setEnv({}));

const FULL = {
  TRUESCORE_MAPS_BGKEY: 'bg', TRUESCORE_MAPS_BGBIND: 'bb',
  TRUESCORE_MAPS_SESSION: 'sid', TRUESCORE_MAPS_AT: 'at',
  TRUESCORE_MAPS_COOKIES: 'SID=x; HSID=y',
};

describe('the env session is all of it or none of it', () => {
  test('a complete env session is adopted as one value', async () => {
    setEnv(FULL);
    const { mapsSession, getMapsCreds } = await freshModule();
    expect(mapsSession()).toEqual({ creds: { bgkey: 'bg', bgbind: 'bb', sessionId: 'sid', at: 'at', hl: 'en' }, cookies: 'SID=x; HSID=y' });
    expect(getMapsCreds()?.bgkey).toBe('bg');
  });

  test('a bgkey with no cookies is refused, not half-adopted', async () => {
    // This was the bug: creds came back with no matching cookie override, so
    // googleFetch paired an env bgkey with the anonymous baked jar — every
    // review RPC empty, read as a stale session, a doomed mint every 60s.
    const { TRUESCORE_MAPS_COOKIES: _drop, ...noCookies } = FULL;
    setEnv(noCookies);
    const { mapsSession, getMapsCreds } = await freshModule();
    expect(mapsSession()).toBeNull();
    expect(getMapsCreds()).toBeNull();
  });

  test('a partial creds set is refused too', async () => {
    setEnv({ TRUESCORE_MAPS_BGKEY: 'bg', TRUESCORE_MAPS_COOKIES: 'SID=x' });
    const { mapsSession } = await freshModule();
    expect(mapsSession()).toBeNull();
  });

  test('unconfigured is null, not a throw — a credless deploy still serves', async () => {
    setEnv({});
    const { mapsSession, mapsSessionHealthy } = await freshModule();
    expect(mapsSession()).toBeNull();
    expect(mapsSessionHealthy()).toBe(false);
  });
});
