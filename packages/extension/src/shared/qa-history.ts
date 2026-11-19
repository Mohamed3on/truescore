import { normalizeQuestion, type AskSearch } from '@truescore/gmaps-shared';
import { storeGet, storeSet } from './cache';

// Recent questions per page (a product, a film, a place): the last
// QA_CACHE_LIMIT Answers, newest first, so asking one again — or clicking its
// chip — replays it instead of calling the model. Shared by every ask widget.
// Questions match normalized ("Dogs allowed?" = "dogs allowed").
const QA_CACHE_LIMIT = 10;
const qaCacheKey = (cacheKey: string) => `${cacheKey}-qa`;

// `searches`: the Searches behind a Google Maps Answer, replayed as its rows.
export interface QAEntry { q: string; a: string; ts: number; searches?: AskSearch[] }

export const loadQAs = async (cacheKey: string): Promise<QAEntry[]> => {
  const saved = await storeGet(qaCacheKey(cacheKey));

  return Array.isArray(saved) ? saved : [];
};

export const findQA = async (cacheKey: string, question: string): Promise<QAEntry | undefined> => {
  const key = normalizeQuestion(question);

  return (await loadQAs(cacheKey)).find((e) => normalizeQuestion(e.q) === key);
};

export const saveQA = async (cacheKey: string, entry: QAEntry): Promise<void> => {
  const key = normalizeQuestion(entry.q);
  const next = [entry, ...(await loadQAs(cacheKey)).filter((e) => normalizeQuestion(e.q) !== key)].slice(0, QA_CACHE_LIMIT);
  await storeSet(qaCacheKey(cacheKey), next);
};

export const removeQA = async (cacheKey: string, q: string): Promise<void> => {
  await storeSet(qaCacheKey(cacheKey), (await loadQAs(cacheKey)).filter((e) => e.q !== q));
};
