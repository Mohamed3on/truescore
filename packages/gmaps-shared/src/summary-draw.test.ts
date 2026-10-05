import { expect, test } from 'bun:test';
import { mountBullets, writeMarkdown } from './summary-draw';

const texts = (list: HTMLElement) => [...list.children].map((c) => c.textContent);
type Bullet = { text: string; n?: number };
const mount = (list: HTMLElement) =>
  mountBullets<Bullet>(list, (b) => b.text, () => document.createElement('li'), (row, b) => { row.textContent = b.n ? `${b.text} (${b.n})` : b.text; });

test('bullets are written in place and dim as they stream, then the check drops, sorts and lights them up', async () => {
  const list = document.createElement('ul');
  list.append(document.createElement('h3'));
  const bullets = mount(list);
  bullets.draft([{ text: 'Lasts' }]);
  const lasts = list.children[1];
  bullets.draft([{ text: 'Lasts long' }, { text: 'Quiet' }, { text: 'Cheap' }]);
  expect(list.children[1]).toBe(lasts);
  expect(texts(list)).toEqual(['', 'Lasts long', 'Quiet', 'Cheap']);
  expect([...list.querySelectorAll('li')].map((li) => li.style.opacity)).toEqual(['0.5', '0.5', '0.5']);

  await bullets.settle([{ text: 'Cheap', n: 3 }, { text: 'Lasts long', n: 2 }]);
  expect(texts(list)).toEqual(['', 'Cheap (3)', 'Lasts long (2)']);
  expect(list.children[2]).toBe(lasts);
  expect([...list.querySelectorAll('li')].map((li) => li.style.opacity)).toEqual(['', '']);
});

test('a summary that was never drafted (a cached one) draws at once', () => {
  const list = document.createElement('div');
  void mount(list).settle([{ text: 'a', n: 2 }, { text: 'b', n: 2 }]);
  expect(texts(list)).toEqual(['a (2)', 'b (2)']);
});

test('markdown is rewritten only when it changed', () => {
  const node = document.createElement('div');
  let renders = 0;
  const render = (n: HTMLElement, t: string) => { renders++; n.textContent = t; };
  writeMarkdown(node, 'Good', render);
  writeMarkdown(node, 'Good', render);
  writeMarkdown(node, 'Good food', render);
  expect([node.textContent, renders]).toEqual(['Good food', 2]);
});
