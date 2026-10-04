import { test, expect, describe } from 'bun:test';
import { parseOrSalvage, salvageNumber, salvageObjects, salvageString, salvageStringArray } from './json-salvage';

// The real failure: a structured call hits maxOutputTokens mid-array, so the
// text is not valid JSON and JSON.parse discards everything the model did say.
const TRUNCATED = `{"conclusion":"Holds up well, but the strap frays.","valueForMoney":4,"praised":["battery life","screen brightness","build qualit`;

describe('salvageStringArray', () => {
  test('reads a complete array', () => {
    expect(salvageStringArray('{"items":["a","b","c"]}', 'items')).toEqual(['a', 'b', 'c']);
  });

  test('keeps the complete elements of a truncated array and drops the fragment', () => {
    expect(salvageStringArray(TRUNCATED, 'praised')).toEqual(['battery life', 'screen brightness']);
  });

  test('an absent field is an empty list, not a throw', () => {
    expect(salvageStringArray(TRUNCATED, 'complaints')).toEqual([]);
  });

  test('elements containing commas and escapes survive', () => {
    expect(salvageStringArray('{"items":["fits, barely","he said \\"no\\""]}', 'items'))
      .toEqual(['fits, barely', 'he said "no"']);
  });

  test('stops at the array it was asked for', () => {
    expect(salvageStringArray('{"a":["x"],"b":["y"]}', 'a')).toEqual(['x']);
  });
});

describe('salvageString / salvageNumber', () => {
  test('read scalars out of the partial text', () => {
    expect(salvageString(TRUNCATED, 'conclusion')).toBe('Holds up well, but the strap frays.');
    expect(salvageNumber(TRUNCATED, 'valueForMoney')).toBe(4);
  });

  test('undefined when the field never appeared', () => {
    expect(salvageString(TRUNCATED, 'betterAlternative')).toBeUndefined();
    expect(salvageNumber(TRUNCATED, 'rating')).toBeUndefined();
  });
});

describe('salvageObjects', () => {
  test('keeps complete objects and skips the interrupted one', () => {
    const text = '{"highlights":[{"text":"great","sentiment":"positive"},{"text":"loud","sentiment":"negative"},{"text":"cut off';
    expect(salvageObjects<{ text: string }>(text, 'text').map((h) => h.text)).toEqual(['great', 'loud']);
  });

  test('ignores objects that do not carry the key', () => {
    expect(salvageObjects('{"meta":{"n":1},"h":{"text":"x"}}', 'text')).toEqual([{ text: 'x' }]);
  });
});

describe('parseOrSalvage', () => {
  test('valid JSON never reaches the salvage path', () => {
    let salvaged = false;
    expect(parseOrSalvage('{"ok":1}', () => { salvaged = true; return {}; })).toEqual({ ok: 1 });
    expect(salvaged).toBe(false);
  });

  test('malformed JSON falls through to salvage instead of throwing', () => {
    expect(parseOrSalvage(TRUNCATED, (raw) => ({ praised: salvageStringArray(raw, 'praised') })))
      .toEqual({ praised: ['battery life', 'screen brightness'] });
  });
});
