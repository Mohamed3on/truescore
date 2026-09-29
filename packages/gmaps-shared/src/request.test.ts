import { test, expect, describe } from 'bun:test';
import { credsFromBatchExecute } from './index';

const FID = '0x1:0x2';

describe('credsFromBatchExecute', () => {
  // Real capture shape: the inner ListUgcPosts request is a JSON string nested
  // inside the outer f.req JSON, so its quotes arrive backslash-escaped.
  const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['qv9Egd',
    JSON.stringify([[[FID]], [10, ''], null, null, ['9RSOasuVJ_qXxc8P8_2Z8QQ', null, null, null, null, null, 81]]),
    null, 'generic']]])) + '&';

  test('lifts the sessionId from the escaped body when bgbind is absent', () => {
    // Google stopped sending x-maps-bgbind on the review RPC; the body is the
    // only source left, and the replay works with an empty bgbind.
    expect(credsFromBatchExecute('BG', '', body).sessionId).toBe('9RSOasuVJ_qXxc8P8_2Z8QQ');
  });
  test('still reads the unescaped bgbind form first', () => {
    const bgbind = '["OTHERSESSIONID123456",null,null,null,null,null,81]';
    expect(credsFromBatchExecute('BG', bgbind, body).sessionId).toBe('OTHERSESSIONID123456');
  });
  test('at is optional', () => {
    expect(credsFromBatchExecute('BG', '', body).at).toBe('');
    expect(credsFromBatchExecute('BG', '', body + 'at=AT%3A1&').at).toBe('AT:1');
  });
});
