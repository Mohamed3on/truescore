import { test, expect } from 'bun:test';
import type { JSONSchema7 } from 'ai';
import { salvageObject } from './llm';

const SCHEMA: JSONSchema7 = {
  type: 'object',
  properties: {
    conclusion: { type: 'string' },
    praised: { type: 'array', items: { type: 'string' } },
    complaints: { type: 'array', items: { type: 'string' } },
    betterAlternative: { type: 'string' },
  },
};

test('a structured reply cut off mid-bullet keeps every field that made it', () => {
  expect(salvageObject('{"conclusion":"Solid.","praised":["battery","screen bright', SCHEMA))
    .toEqual({ conclusion: 'Solid.', praised: ['battery'], complaints: [], betterAlternative: '' });
});
