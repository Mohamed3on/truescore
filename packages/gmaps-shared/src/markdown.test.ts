import { test, expect, describe } from 'bun:test';
import { mdInline, mdToHtml } from './markdown';

// Regression for the BJJ Fanatics verdict bug: nano:medium emitted an odd run of
// `**` ("…grab-bag of techniques.**** The single…"). The old left-to-right
// pairer matched the stray marker with the wrong neighbor and inverted emphasis,
// bolding the connectors instead of the specifics (see evals/bjjfanatics.ts).
test('stray/odd ** does not invert emphasis and leaves no literal markers', () => {
  const out = mdInline(
    '**Buy this if you want a complete seated open-guard attack game (gi or no-gi), not a grab-bag of techniques.**** The single most important takeaway',
  );
  // The intended span is bold…
  expect(out).toContain(
    '<strong>Buy this if you want a complete seated open-guard attack game (gi or no-gi), not a grab-bag of techniques.</strong>',
  );
  // …the trailing prose is NOT dragged into a bold span…
  expect(out).not.toMatch(/<strong>[^<]*The single most important/);
  // …and no orphan ** is left to render as literal asterisks.
  expect(out).not.toContain('**');
});

test('well-formed bold still marks the specific, not the connector', () => {
  const out = mdInline('then prioritize the **shin-to-shin/ashi entry details**, because it helps');
  expect(out).toContain('<strong>shin-to-shin/ashi entry details</strong>');
  expect(out).not.toMatch(/<strong>[^<]*then prioritize/);
});

test('a leading stray ** cannot bold the connector that follows it', () => {
  // Old behavior paired (stray, next) → bolded " start with the ". New: the
  // space-flanked stray is dropped, and the real specific stays bold.
  const out = mdInline('** start with the **shoulder crunch sweep** before drilling');
  expect(out).toContain('<strong>shoulder crunch sweep</strong>');
  expect(out).not.toMatch(/<strong>[^<]*start with the/);
  expect(out).not.toContain('**');
});

test('multiple clean bold spans are all preserved', () => {
  const out = mdInline('the **shoulder crunch sweep** and the **sumi gaeshi** entries');
  expect(out).toContain('<strong>shoulder crunch sweep</strong>');
  expect(out).toContain('<strong>sumi gaeshi</strong>');
});

// Models also emit underscore emphasis (_italic_ / __bold__); the renderer used
// to print the literal underscores ("…signature _shoulder crunch sweep_.").
test('underscore emphasis renders, including nested inside a bold lead', () => {
  expect(mdInline("the signature _shoulder crunch sweep_.")).toContain('<em>shoulder crunch sweep</em>');
  const out = mdInline('**finish with the signature _shoulder crunch sweep_.**');
  expect(out).toContain('<strong>');
  expect(out).toContain('<em>shoulder crunch sweep</em>');
  expect(out).not.toContain('_');
});

test('__double underscore__ is bold', () => {
  expect(mdInline('the __shoulder crunch__ sweep')).toContain('<strong>shoulder crunch</strong>');
});

test('intra-word underscores (snake_case, urls) are left alone', () => {
  const out = mdInline('use snake_case_here in code');
  expect(out).not.toContain('<em>');
  expect(out).toContain('snake_case_here');
});

test('escapes HTML and renders inline code', () => {
  expect(mdInline('a <script> & `code`')).toBe('a &lt;script&gt; &amp; <code>code</code>');
});

test('renders links with a safe target', () => {
  expect(mdInline('see [the docs](https://example.com/x)')).toBe(
    'see <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">the docs</a>',
  );
});

// mdToHtml's block layer was previously untested (the web copy only imported
// mdInline). Cover the block shapes the summaries actually use.
describe('mdToHtml blocks', () => {
  test('headings by level', () => {
    expect(mdToHtml('# Title')).toBe('<h1>Title</h1>');
    expect(mdToHtml('### Sub')).toBe('<h3>Sub</h3>');
  });

  test('bulleted and numbered lists', () => {
    expect(mdToHtml('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(mdToHtml('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  test('soft-wrapped lines join with <br>; a blank line splits paragraphs', () => {
    expect(mdToHtml('line one\nline two')).toBe('<p>line one<br>line two</p>');
    expect(mdToHtml('para one\n\npara two')).toBe('<p>para one</p><p>para two</p>');
  });

  test('inline formatting applies inside a block', () => {
    expect(mdToHtml('- **bold** item')).toBe('<ul><li><strong>bold</strong> item</li></ul>');
  });
});
