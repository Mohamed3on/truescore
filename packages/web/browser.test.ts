import { test, expect, describe } from 'bun:test';
import { assertGoogleHost } from './browser';

describe('assertGoogleHost', () => {
  test('allows google.com and its subdomains', () => {
    expect(() => assertGoogleHost('https://www.google.com/maps/rpc/listugcposts?x=1')).not.toThrow();
    expect(() => assertGoogleHost('https://google.com/maps?q=&ftid=0x1:0x2')).not.toThrow();
    expect(() => assertGoogleHost('https://maps.google.com/anything')).not.toThrow();
  });

  test('rejects non-Google hosts', () => {
    expect(() => assertGoogleHost('http://attacker.example/x?ftid=0x1:0x2')).toThrow();
    expect(() => assertGoogleHost('http://localhost:3000/')).toThrow();
    expect(() => assertGoogleHost('http://169.254.169.254/latest/meta-data/')).toThrow();
  });

  test('rejects look-alike hosts that only contain "google.com" as a substring', () => {
    expect(() => assertGoogleHost('https://google.com.attacker.example/x')).toThrow();
    expect(() => assertGoogleHost('https://notgoogle.com/x')).toThrow();
    expect(() => assertGoogleHost('https://evilgoogle.com/x')).toThrow();
  });

  test('rejects a malformed URL', () => {
    expect(() => assertGoogleHost('not a url')).toThrow();
  });
});
