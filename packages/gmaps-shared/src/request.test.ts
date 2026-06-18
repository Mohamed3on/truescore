import { test, expect, describe } from 'bun:test';
import { buildListReq, buildTokenReq, buildSearchReq, PAGE_SIZE, type MapsCreds, type MapsReq } from './index';

// Pins the reverse-engineered ListUgcPosts f.req shape (from real qv9Egd curls):
// place in slot 0[0], query in 0[2], highlight token in 0[4], page size + cursor
// in slot 1, sessionId in the 81-tagged slot 4, and trailing [2]=newest / [1]=relevant.
const creds: MapsCreds = { bgkey: 'BG', bgbind: 'BB', sessionId: 'SID', at: 'AT:1', hl: 'en' };
const FID = '0x1:0x2';

// Decode the inner request array out of a built MapsReq's POST body.
const inner = (req: MapsReq): any[] => {
  const fReq = decodeURIComponent((req.init!.body!.match(/f\.req=([^&]*)/) || [])[1]!);
  return JSON.parse(JSON.parse(fReq)[0][0][1]); // [[['/Maps…', <inner JSON string>, null, 'generic']]]
};

describe('batchexecute request builders', () => {
  test('newest sort: trailing [2], no token/query, place + page size + session', () => {
    const i = inner(buildListReq(FID, 'newest', creds));
    expect(i[0][0]).toEqual([FID]);
    expect(i[0][2]).toBeNull();           // no query
    expect(i[0][4]).toBeNull();           // no token
    expect(i[1]).toEqual([PAGE_SIZE, '']); // page size + empty cursor
    expect(i[4][0]).toBe('SID');          // session id, 81-tagged
    expect(i[4][6]).toBe(81);
    expect(i.at(-1)).toEqual([2]);        // newest
  });
  test('relevant sort: trailing [1]', () => {
    expect(inner(buildListReq(FID, 'relevant', creds)).at(-1)).toEqual([1]);
  });
  test('cursor rides slot 1', () => {
    expect(inner(buildListReq(FID, 'newest', creds, 'CUR'))[1]).toEqual([PAGE_SIZE, 'CUR']);
  });
  test('highlight token → slot 0[4], newest order', () => {
    const i = inner(buildTokenReq(FID, 'TOK', creds));
    expect(i[0][4]).toEqual([['TOK']]);
    expect(i[0][2]).toBeNull();
    expect(i.at(-1)).toEqual([2]);
  });
  test('search query → slot 0[2], relevant order', () => {
    const i = inner(buildSearchReq(FID, 'tapas', creds));
    expect(i[0][2]).toBe('tapas');
    expect(i[0][4]).toBeNull();
    expect(i.at(-1)).toEqual([1]);
  });
  test('url + headers + at carry the creds', () => {
    const req = buildListReq(FID, 'newest', creds);
    expect(req.url).toContain('rpcids=qv9Egd');
    expect(req.url).toContain('hl=en');
    expect(req.init!.headers!['x-maps-bgkey']).toBe('BG');
    expect(req.init!.headers!['x-maps-bgbind']).toBe('BB');
    expect(req.init!.body).toContain('at=AT%3A1'); // url-encoded
  });
});
