// Picks the user has muted from a site's better-picks list, one id set per
// storage key. Deliberately not a cache — it's user intent, so it lives in
// chrome.storage.local: no TTL, survives clearing the site's data, and untouched
// by the background rc_score_* sweep.

const readIgnored = async (key: string): Promise<Set<string>> => {
  const stored = (await chrome.storage.local.get(key))[key];

  return new Set<string>(Array.isArray(stored) ? stored : []);
};

export const loadIgnored = (key: string) => readIgnored(key).catch(() => new Set<string>());

// One id against what is stored now: saving this tab's whole set would drop
// whatever another open tab ignored since this one loaded.
export const saveIgnored = (key: string, id: string, ignore: boolean) =>
  readIgnored(key).then((ignored) => {
    if (ignore) ignored.add(id); else ignored.delete(id);

    return chrome.storage.local.set({ [key]: [...ignored] });
  }).catch(() => {});
