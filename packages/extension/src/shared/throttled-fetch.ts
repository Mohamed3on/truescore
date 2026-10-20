type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;

export function createThrottledFetcher(concurrency: number, fetcher: Fetcher = fetch) {
  let active = 0;
  const queue: { fn: () => Promise<Response>; priority: number; resolve: (v: Response) => void; reject: (e: any) => void }[] = [];
  const next = () => {
    while (active < concurrency && queue.length) {
      active++;
      const { fn, resolve, reject } = queue.shift()!;
      fn().then(resolve, reject).finally(() => { active--; next(); });
    }
  };
  // Lower `priority` runs sooner; equal ones keep their order.
  return (url: string, options?: RequestInit, priority = 0) => new Promise<Response>((resolve, reject) => {
    const at = queue.findIndex((q) => q.priority > priority);
    queue.splice(at < 0 ? queue.length : at, 0, { fn: () => fetcher(url, options), priority, resolve, reject });
    next();
  });
}
