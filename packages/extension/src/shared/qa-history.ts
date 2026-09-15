import { normalizeQuestion, type AskSearch } from '@truescore/gmaps-shared';

// Recent questions per page (a product, a film, a place): the last
// QA_CACHE_LIMIT Answers in localStorage, newest first, so asking one again —
// or clicking its chip — replays it instead of calling the model. Shared by
// every ask widget. Questions match normalized ("Dogs allowed?" = "dogs allowed").
const QA_CACHE_LIMIT = 10;
const qaCacheKey = (cacheKey: string) => `${cacheKey}-qa`;

// `searches`: the Searches behind a Google Maps Answer, replayed as its rows.
export interface QAEntry { q: string; a: string; ts: number; searches?: AskSearch[] }

export const loadQAs = (cacheKey: string): QAEntry[] => {
  try {
    const raw = localStorage.getItem(qaCacheKey(cacheKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

export const findQA = (cacheKey: string, question: string): QAEntry | undefined => {
  const key = normalizeQuestion(question);
  return loadQAs(cacheKey).find((e) => normalizeQuestion(e.q) === key);
};

export const saveQA = (cacheKey: string, entry: QAEntry) => {
  const key = normalizeQuestion(entry.q);
  const next = [entry, ...loadQAs(cacheKey).filter((e) => normalizeQuestion(e.q) !== key)].slice(0, QA_CACHE_LIMIT);
  try { localStorage.setItem(qaCacheKey(cacheKey), JSON.stringify(next)); } catch {}
};

export const removeQA = (cacheKey: string, q: string) => {
  const existing = loadQAs(cacheKey).filter((e) => e.q !== q);
  try { localStorage.setItem(qaCacheKey(cacheKey), JSON.stringify(existing)); } catch {}
};
